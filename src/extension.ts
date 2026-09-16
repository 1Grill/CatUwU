import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { advanceAction, CAT_ACTIONS, spriteFrame, stageAction, type ActionDefinition, type AnimationState, type CatAction } from './actions';
import { chooseTalkLine, createSpeechBubble, loadTalkLines, type SpeechBubble, type TalkLine, type TalkTrigger } from './talk';

const CAT_SCALE = 3;
const CAT_BASE_SIZE_PX = 32;
const AUTO_ACTIONS = ['sit', 'walk'] as const;
const MAX_AUTO_REPEAT_BONUS = 4;
export interface CatImageOptions {
	action: CatAction;
	frame: number;
	mirrored: boolean;
	scale: number;
	pixelOffsetX: number;
	pixelOffsetY: number;
}

interface SpeechState { text: string; visibleCharacters: number; }
interface HorizontalBounds { min: number; max: number; }
interface BubblePlacement { bubble: SpeechBubble; x: number; }

/** Scale and mirror a sprite without creating generated files on disk. */
export function createCatImage(extensionUri: vscode.Uri, options: CatImageOptions): vscode.Uri {
	const sprite = spriteFrame(options.action, options.frame);
	const pngUri = vscode.Uri.joinPath(extensionUri, 'src', 'animation', sprite.directory, sprite.file);
	const png = readFileSync(pngUri.fsPath);
	const pngBase64 = png.toString('base64');
	const flip = options.mirrored ? ` transform="translate(${CAT_BASE_SIZE_PX} 0) scale(-1 1)"` : '';
	const svg = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${CAT_BASE_SIZE_PX * options.scale}" height="${CAT_BASE_SIZE_PX * options.scale}" viewBox="0 0 ${CAT_BASE_SIZE_PX} ${CAT_BASE_SIZE_PX}">`,
		`<g${flip}><image href="data:image/png;base64,${pngBase64}" width="${CAT_BASE_SIZE_PX}" height="${CAT_BASE_SIZE_PX}" image-rendering="pixelated"/>`,
		'</g>',
		'</svg>',
	].join('');
	return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

/** Put the speech frame behind the sprite in one image, so the bubble can never cover the cat. */
function createCatWithBubbleImage(extensionUri: vscode.Uri, options: CatImageOptions, placement: BubblePlacement): { uri: vscode.Uri; width: number; height: number; left: number } {
	const catSize = CAT_BASE_SIZE_PX * options.scale;
	const catX = options.pixelOffsetX * options.scale;
	const left = Math.min(catX, placement.x);
	const catLeft = catX - left;
	const bubbleLeft = placement.x - left;
	const gap = 4;
	const width = Math.max(catLeft + catSize, bubbleLeft + placement.bubble.width);
	const height = placement.bubble.height + gap + catSize;
	const svg = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges">`,
		`<image href="${placement.bubble.dataUri}" x="${bubbleLeft}" y="0" width="${placement.bubble.width}" height="${placement.bubble.height}" image-rendering="pixelated"/>`,
		`<image href="${createCatImage(extensionUri, options).toString()}" x="${catLeft}" y="${placement.bubble.height + gap}" width="${catSize}" height="${catSize}" image-rendering="pixelated"/>`,
		'</svg>',
	].join('');
	return { uri: vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`), width, height, left };
}

class Cat {
	private readonly costumes = new Map<string, vscode.TextEditorDecorationType>();
	private talkLines: TalkLine[];
	private targetLine: number | undefined;
	private targetEditor: vscode.TextEditor | undefined;
	private action: CatAction = 'walk';
	private state: AnimationState = stageAction('walk', { direction: 1 });
	private mode: 'auto' | 'ordered' = 'auto';
	private queuedActions: CatAction[] = [];
	private previousAutoAction: CatAction | undefined;
	private autoActionCycles = 0;
	private jumpTargetLine: number | undefined;
	private animationTimer: ReturnType<typeof setTimeout> | undefined;
	private renderedEditor: vscode.TextEditor | undefined;
	private renderedCostumeKey: string | undefined;
	private speech: SpeechState | undefined;
	private speechTimer: ReturnType<typeof setTimeout> | undefined;
	private hadError = false;

	public constructor(private readonly extensionUri: vscode.Uri) { this.talkLines = loadTalkLines(extensionUri); }
	public summon(editor: vscode.TextEditor): void {
		this.targetEditor = editor;
		this.targetLine = editor.selection.active.line + 1;
		this.action = 'walk';
		this.state = stageAction('walk', { direction: 1 });
		this.mode = 'auto';
		this.queuedActions = [];
		this.previousAutoAction = undefined;
		this.autoActionCycles = 0;
		this.jumpTargetLine = undefined;
		this.hadError = this.documentHasError(editor.document.uri);
		this.restartAnimation();
		this.render();
		this.talk('summon');
	}
	/** Start an action now; normal Auto behaviour takes over when it completes. */
	public order(action: CatAction | 'auto'): boolean {
		if (this.targetLine === undefined) {return false;}
		if (action === 'auto') {
			this.mode = 'auto';
			this.queuedActions = [];
			this.previousAutoAction = undefined;
			this.autoActionCycles = 0;
		} else {
			this.mode = 'auto';
			this.queuedActions = [];
			const transition = this.transitionFor(action);
			if (transition) {this.queuedActions = [action];}
			this.action = transition ?? action;
			this.state = stageAction(this.action, { direction: this.state.direction, pixelOffsetX: this.state.pixelOffsetX });
			this.restartAnimation();
			this.render();
		}
		return true;
	}
	/** Start a directional hop. The line changes after its landing frame. */
	public jump(direction: 'up' | 'down'): boolean {
		if (this.targetLine === undefined || !this.ensureVisibleEditor()) {return false;}
		const target = this.targetLine + (direction === 'up' ? -1 : 1);
		if (target < 1 || target > this.targetEditor!.document.lineCount || !this.isLineVisible(this.targetEditor!, target - 1)) {return false;}
		this.stageJump(target);
		this.talk('jump');
		return true;
	}
	/** Speak a random JSON line that matches the current document and trigger. */
	public talk(trigger: TalkTrigger = 'any'): void {
		if (!this.targetEditor) {return;}
		const text = chooseTalkLine(this.talkLines, { trigger, languageId: this.targetEditor.document.languageId, hasError: this.documentHasError(this.targetEditor.document.uri) });
		if (!text) {return;}
		if (this.speechTimer !== undefined) {clearTimeout(this.speechTimer);}
		this.speech = { text, visibleCharacters: 0 };
		this.advanceSpeech();
	}
	public reloadTalkLines(): void { this.talkLines = loadTalkLines(this.extensionUri); }
	/** Only react when diagnostics transition into an error state, avoiding chatter while a language server refreshes. */
	public handleDiagnostics(uri: vscode.Uri): void {
		if (!this.targetEditor || this.targetEditor.document.uri.toString() !== uri.toString()) {return;}
		const hasError = this.documentHasError(uri);
		if (hasError && !this.hadError) {this.talk('error');}
		this.hadError = hasError;
	}
	/** React to shortened text by walking back, or hopping to a nearby usable line. */
	public handleDocumentChange(event: vscode.TextDocumentChangeEvent): void {
		if (!this.targetEditor || this.targetEditor.document !== event.document || this.targetLine === undefined) {return;}
		const line = this.targetLine - 1;
		if (line >= event.document.lineCount) {return;}
		const lineLength = event.document.lineAt(line).text.length;
		if (this.state.pixelOffsetX <= lineLength * 4) {return;}
		const destination = this.findJumpDestination(event.document, line);
		if (lineLength < 3 && destination !== undefined) {
			this.stageJump(destination + 1);
			return;
		}
		// Finish what the cat is doing, walk back onto the remaining text, then sit.
		if (this.action !== 'walk') {
			this.mode = 'auto';
			this.queuedActions = ['walk', 'sit'];
		}
	}
	public get isSummoned(): boolean { return this.targetLine !== undefined; }
	public render(): void {
		if (this.targetLine === undefined) {return this.clearRenderedCostume();}
		const editor = this.ensureVisibleEditor();
		const line = this.targetLine - 1;
		if (!editor || line >= editor.document.lineCount) {return this.clearRenderedCostume();}
		const bounds = this.horizontalBounds(editor, line);
		this.state.pixelOffsetX = Math.max(bounds.min, Math.min(bounds.max, this.state.pixelOffsetX));
		const position = new vscode.Position(line, 0);
		const bubble = this.speechBubble(bounds);
		this.renderImage(editor, { action: this.action, frame: this.state.frameIndex, mirrored: this.definition.mirrored(this.state), scale: CAT_SCALE, pixelOffsetX: this.state.pixelOffsetX, pixelOffsetY: this.state.pixelOffsetY }, new vscode.Range(position, position), bubble);
	}
	public dispose(): void {
		if (this.animationTimer !== undefined) {clearTimeout(this.animationTimer);}
		if (this.speechTimer !== undefined) {clearTimeout(this.speechTimer);}
		this.clearRenderedCostume();
		for (const costume of this.costumes.values()) {costume.dispose();}
	}
	private get definition(): ActionDefinition { return CAT_ACTIONS[this.action]; }
	private restartAnimation(): void {
		if (this.animationTimer !== undefined) {clearTimeout(this.animationTimer);}
		this.scheduleNextFrame(this.action === 'sit' ? 210 : this.action === 'standUp' || this.action === 'sitDown' ? 100 : randomBetween(90, 160));
	}
	private scheduleNextFrame(delay: number): void { this.animationTimer = setTimeout(() => this.advanceAnimation(), delay); }
	private advanceAnimation(): void {
		if (this.targetLine === undefined) {return;}
		const editor = this.ensureVisibleEditor();
		if (!editor) {return;}
		const line = this.targetLine - 1;
		const lineLength = line < editor.document.lineCount ? editor.document.lineAt(line).text.length : 0;
		const horizontal = this.horizontalBounds(editor, line);
		const step = advanceAction(this.action, this.state, { lineLength, lineHeight: this.lineHeightInSpritePixels(editor), minPixelOffsetX: horizontal.min, maxPixelOffsetX: horizontal.max });
		this.render();
		if (step.complete) {
			const delay = this.action === 'sit' ? 0 : step.delay;
			this.animationTimer = setTimeout(() => {
				if (this.action === 'jumpUp' || this.action === 'jumpDown') {
					if (this.jumpTargetLine !== undefined) {this.targetLine = this.jumpTargetLine;}
					this.jumpTargetLine = undefined;
				}
				this.startNextAction();
			}, delay);
		} else {this.scheduleNextFrame(step.delay);}
	}
	private startNextAction(): void {
		const nextAction = this.queuedActions.shift() ?? (this.mode === 'auto' ? this.chooseAutoAction() : this.action);
		const transition = this.transitionFor(nextAction);
		if (transition) {this.queuedActions.unshift(nextAction);}
		this.action = transition ?? nextAction;
		this.state = stageAction(this.action, { direction: this.state.direction, pixelOffsetX: this.state.pixelOffsetX });
		this.render();
		if (nextAction === 'sit' && this.mode === 'auto' && !this.speech && Math.random() < 0.2) {this.talk('idle');}
		this.restartAnimation();
	}
	private transitionFor(nextAction: CatAction): 'standUp' | 'sitDown' | undefined {
		if (this.action === 'sit' && nextAction === 'walk') {return 'standUp';}
		if (this.action === 'walk' && nextAction === 'sit') {return 'sitDown';}
		return undefined;
	}
	/** Prefer an action the longer it has been repeated, without making Auto get stuck. */
	private chooseAutoAction(): typeof AUTO_ACTIONS[number] {
		if (this.previousAutoAction === this.action) {this.autoActionCycles += 1;}
		else {
			this.previousAutoAction = this.action;
			this.autoActionCycles = 1;
		}
		const repeatBonus = Math.min(this.autoActionCycles, MAX_AUTO_REPEAT_BONUS);
		const weightFor = (action: typeof AUTO_ACTIONS[number]): number => CAT_ACTIONS[action].autoWeight + (action === this.action ? repeatBonus : 0);
		const totalWeight = AUTO_ACTIONS.reduce((total, action) => total + weightFor(action), 0);
		let pick = Math.random() * totalWeight;
		for (const action of AUTO_ACTIONS) {
			pick -= weightFor(action);
			if (pick < 0) {return action;}
		}
		return AUTO_ACTIONS[AUTO_ACTIONS.length - 1];
	}
	private stageJump(targetLine: number): void {
		if (this.targetLine === undefined) {return;}
		this.mode = 'auto';
		this.jumpTargetLine = targetLine;
		this.queuedActions = [];
		this.action = targetLine < this.targetLine ? 'jumpUp' : 'jumpDown';
		this.state = stageAction(this.action, { direction: this.state.direction, pixelOffsetX: this.state.pixelOffsetX });
		this.restartAnimation();
		this.render();
	}
	private findJumpDestination(document: vscode.TextDocument, currentLine: number): number | undefined {
		const candidates = [currentLine - 1, currentLine + 1].filter((line) => line >= 0 && line < document.lineCount && this.targetEditor && this.isLineVisible(this.targetEditor, line));
		return candidates.length === 0 ? undefined : candidates[Math.floor(Math.random() * candidates.length)];
	}
	/** Keep the cat attached to a visible line, including after scrolling or changing editor groups. */
	private ensureVisibleEditor(): vscode.TextEditor | undefined {
		if (!this.targetEditor || !vscode.window.visibleTextEditors.includes(this.targetEditor)) {
			const replacement = vscode.window.activeTextEditor;
			if (!replacement) {return undefined;}
			this.targetEditor = replacement;
			this.targetLine = replacement.selection.active.line + 1;
			this.state.pixelOffsetX = 0;
			this.jumpTargetLine = undefined;
			if (this.action === 'jumpUp' || this.action === 'jumpDown') {
				this.action = 'sit';
				this.state = stageAction('sit', { direction: this.state.direction, pixelOffsetX: 0 });
			}
		}
		if (this.targetLine === undefined || this.targetEditor.visibleRanges.length === 0) {return undefined;}
		const visible = this.targetEditor.visibleRanges;
		const first = visible[0].start.line;
		const last = visible[visible.length - 1].end.line;
		const visibleLine = Math.max(first, Math.min(last, this.targetLine - 1));
		if (visibleLine !== this.targetLine - 1 && (this.action === 'jumpUp' || this.action === 'jumpDown')) {
			this.jumpTargetLine = undefined;
			this.action = 'sit';
			this.state = stageAction('sit', { direction: this.state.direction, pixelOffsetX: this.state.pixelOffsetX });
		}
		this.targetLine = visibleLine + 1;
		return this.targetEditor;
	}
	private horizontalBounds(editor: vscode.TextEditor, line: number): HorizontalBounds {
		const lineLength = editor.document.lineAt(line).text.length;
		const visible = editor.visibleRanges.find((range) => range.start.line <= line && line <= range.end.line);
		if (!visible) {return { min: 0, max: Math.max(0, (lineLength * 4) - CAT_BASE_SIZE_PX) };}
		const start = visible.start.line === line ? visible.start.character * 4 : 0;
		const endCharacter = visible.end.line === line && visible.end.character > 0 ? Math.min(lineLength, visible.end.character) : lineLength;
		return { min: Math.min(start, Math.max(0, (lineLength * 4) - CAT_BASE_SIZE_PX)), max: Math.max(start, (endCharacter * 4) - CAT_BASE_SIZE_PX) };
	}
	private advanceSpeech(): void {
		if (!this.speech) {return;}
		this.speech.visibleCharacters = Math.min(Array.from(this.speech.text).length, this.speech.visibleCharacters + 1);
		this.render();
		if (this.speech.visibleCharacters < Array.from(this.speech.text).length) { this.speechTimer = setTimeout(() => this.advanceSpeech(), 38); }
		else { this.speechTimer = setTimeout(() => { this.speech = undefined; this.render(); }, 3600); }
	}
	private speechBubble(bounds: HorizontalBounds): BubblePlacement | undefined {
		if (!this.speech) {return undefined;}
		const widthInColumns = Math.max(10, Math.min(22, Math.floor((bounds.max - this.state.pixelOffsetX + CAT_BASE_SIZE_PX) / 4)));
		const bubble = createSpeechBubble(this.speech.text, this.speech.visibleCharacters, widthInColumns);
		const catX = this.state.pixelOffsetX * CAT_SCALE;
		const availableRight = (bounds.max - this.state.pixelOffsetX + CAT_BASE_SIZE_PX) * CAT_SCALE;
		return { bubble, x: bubble.width <= availableRight ? catX : Math.max(0, catX - bubble.width + (CAT_BASE_SIZE_PX * CAT_SCALE)) };
	}
	private documentHasError(uri: vscode.Uri): boolean { return vscode.languages.getDiagnostics(uri).some((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error); }
	private renderImage(editor: vscode.TextEditor, image: CatImageOptions, range: vscode.Range, bubble?: BubblePlacement): void {
		const key = `${image.action}/${image.frame}/${image.mirrored}/${image.scale}/${image.pixelOffsetX}/${image.pixelOffsetY}/${bubble?.bubble.dataUri ?? ''}/${bubble?.x ?? ''}`;
		let decoration = this.costumes.get(key);
		if (!decoration) {
			const size = CAT_BASE_SIZE_PX * image.scale;
			const horizontalOffset = image.pixelOffsetX * image.scale;
			const verticalOffset = image.pixelOffsetY * image.scale;
			const combined = bubble ? createCatWithBubbleImage(this.extensionUri, image, bubble) : undefined;
			const width = combined?.width ?? size;
			const height = combined?.height ?? size;
			const left = combined?.left ?? horizontalOffset;
			decoration = vscode.window.createTextEditorDecorationType({ after: { contentIconPath: combined?.uri ?? createCatImage(this.extensionUri, image), width: `${width}px`, height: `${height}px`, margin: `${-height + verticalOffset}px ${-width - left}px 0 ${left}px` }, rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed });
			this.costumes.set(key, decoration);
		}
		editor.setDecorations(decoration, [range]);
		if (this.renderedEditor && this.renderedCostumeKey && (this.renderedEditor !== editor || this.renderedCostumeKey !== key)) {this.renderedEditor.setDecorations(this.costumes.get(this.renderedCostumeKey)!, []);}
		this.renderedEditor = editor;
		this.renderedCostumeKey = key;
	}
	private lineHeightInSpritePixels(editor: vscode.TextEditor): number {
		const settings = vscode.workspace.getConfiguration('editor', editor.document.uri);
		const configuredLineHeight = settings.get<number>('lineHeight', 0);
		const lineHeight = configuredLineHeight > 0 ? configuredLineHeight : settings.get<number>('fontSize', 14) * 1.5;
		return lineHeight / CAT_SCALE;
	}
	private isLineVisible(editor: vscode.TextEditor, line: number): boolean { return editor.visibleRanges.some((range) => range.start.line <= line && line <= range.end.line); }
	private clearRenderedCostume(): void {
		if (!this.renderedEditor || !this.renderedCostumeKey) {return;}
		this.renderedEditor.setDecorations(this.costumes.get(this.renderedCostumeKey)!, []);
		this.renderedEditor = undefined;
		this.renderedCostumeKey = undefined;
	}
}
function randomBetween(min: number, max: number): number { return min + Math.random() * (max - min); }

export function activate(context: vscode.ExtensionContext): void {
	const cat = new Cat(context.extensionUri);
	const summon = (): void => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) { void vscode.window.showInformationMessage('Open an editor before summoning catUwU.'); return; }
		cat.summon(editor);
	};
	const chooseAction = async (): Promise<void> => {
		if (!cat.isSummoned) { void vscode.window.showInformationMessage('Summon catUwU before giving it an order.'); return; }
		const choice = await vscode.window.showQuickPick([
			{ label: '$(sync) Auto', value: 'auto' as const, description: 'Let the cat alternate walking and sitting' },
			...(['sit', 'walk'] as const).map((value) => ({ label: CAT_ACTIONS[value].label, value, description: CAT_ACTIONS[value].description })),
			{ label: CAT_ACTIONS.jumpUp.label, value: 'jumpUp' as const, description: CAT_ACTIONS.jumpUp.description },
			{ label: CAT_ACTIONS.jumpDown.label, value: 'jumpDown' as const, description: CAT_ACTIONS.jumpDown.description },
			{ label: '$(comment-discussion) Talk', value: 'talk' as const, description: 'Say a matching random line' },
		], { placeHolder: 'What should catUwU do now?' });
		if (!choice) {return;}
		if (choice.value === 'talk') {cat.talk('any');}
		else if (choice.value === 'jumpUp') {
			if (!cat.jump('up')) {void vscode.window.showInformationMessage('There is no line above for catUwU to jump to.');}
		} else if (choice.value === 'jumpDown') {
			if (!cat.jump('down')) {void vscode.window.showInformationMessage('There is no line below for catUwU to jump to.');}
		} else {cat.order(choice.value); if (choice.value !== 'auto') {cat.talk('action');}}
	};
	context.subscriptions.push(vscode.commands.registerCommand('catuwu.summon', summon), vscode.commands.registerCommand('catuwu.action', chooseAction), vscode.window.onDidChangeTextEditorVisibleRanges(() => cat.render()), vscode.window.onDidChangeVisibleTextEditors(() => cat.render()), vscode.window.onDidChangeActiveTextEditor(() => cat.render()), vscode.window.onDidChangeTextEditorViewColumn(() => cat.render()), vscode.languages.onDidChangeDiagnostics((event) => event.uris.forEach((uri) => cat.handleDiagnostics(uri))), vscode.workspace.onDidChangeConfiguration((event) => { if (event.affectsConfiguration('catuwu.talkFile')) {cat.reloadTalkLines();} }), vscode.workspace.onDidChangeTextDocument((event) => { cat.handleDocumentChange(event); cat.render(); }), new vscode.Disposable(() => cat.dispose()));
}
export function deactivate(): void {}
