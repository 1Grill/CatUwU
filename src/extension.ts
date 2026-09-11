import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { advanceAction, CAT_ACTIONS, spriteFrame, stageAction, type ActionDefinition, type AnimationState, type CatAction } from './actions';

const CAT_SCALE = 2;
const CAT_BASE_SIZE_PX = 24;
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

class Cat {
	private readonly costumes = new Map<string, vscode.TextEditorDecorationType>();
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

	public constructor(private readonly extensionUri: vscode.Uri) {}
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
		this.restartAnimation();
		this.render();
	}
	/** Queue an order. The current action is allowed to reach its natural end first. */
	public order(action: CatAction | 'auto'): boolean {
		if (this.targetLine === undefined) {return false;}
		if (action === 'auto') {
			this.mode = 'auto';
			this.queuedActions = [];
			this.previousAutoAction = undefined;
			this.autoActionCycles = 0;
		} else {
			this.mode = 'ordered';
			this.queuedActions = [action];
		}
		return true;
	}
	/** Stage a vertical hop. The line changes after the hop's landing frame. */
	public jump(direction: 'up' | 'down'): boolean {
		if (this.targetLine === undefined || !this.targetEditor) {return false;}
		const target = this.targetLine + (direction === 'up' ? -1 : 1);
		if (target < 1 || target > this.targetEditor.document.lineCount) {return false;}
		this.stageJump(target);
		return true;
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
			this.mode = 'ordered';
			this.queuedActions = ['walk', 'sit'];
		}
	}
	public get isSummoned(): boolean { return this.targetLine !== undefined; }
	public render(): void {
		if (this.targetLine === undefined) {return this.clearRenderedCostume();}
		const editor = this.targetEditor;
		const line = this.targetLine - 1;
		if (!editor || !vscode.window.visibleTextEditors.includes(editor) || line >= editor.document.lineCount || !this.isLineVisible(editor, line)) {return this.clearRenderedCostume();}
		const position = new vscode.Position(line, 0);
		this.renderImage(editor, { action: this.action, frame: this.state.frameIndex, mirrored: this.definition.mirrored(this.state), scale: CAT_SCALE, pixelOffsetX: this.state.pixelOffsetX, pixelOffsetY: this.state.pixelOffsetY }, new vscode.Range(position, position));
	}
	public dispose(): void {
		if (this.animationTimer !== undefined) {clearTimeout(this.animationTimer);}
		this.clearRenderedCostume();
		for (const costume of this.costumes.values()) {costume.dispose();}
	}
	private get definition(): ActionDefinition { return CAT_ACTIONS[this.action]; }
	private restartAnimation(): void {
		if (this.animationTimer !== undefined) {clearTimeout(this.animationTimer);}
		this.scheduleNextFrame(this.action === 'sit' ? 210 : randomBetween(90, 160));
	}
	private scheduleNextFrame(delay: number): void { this.animationTimer = setTimeout(() => this.advanceAnimation(), delay); }
	private advanceAnimation(): void {
		if (this.targetLine === undefined) {return;}
		const line = this.targetLine - 1;
		const lineLength = this.targetEditor && line < this.targetEditor.document.lineCount ? this.targetEditor.document.lineAt(line).text.length : 0;
		const lineHeight = this.targetEditor ? this.lineHeightInSpritePixels(this.targetEditor) : CAT_BASE_SIZE_PX / 2;
		const step = advanceAction(this.action, this.state, { lineLength, lineHeight });
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
		this.action = nextAction;
		this.state = stageAction(nextAction, { direction: this.state.direction, pixelOffsetX: this.state.pixelOffsetX });
		this.render();
		this.restartAnimation();
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
		this.mode = 'ordered';
		this.jumpTargetLine = targetLine;
		this.queuedActions = [targetLine < this.targetLine ? 'jumpUp' : 'jumpDown', 'sit'];
	}
	private findJumpDestination(document: vscode.TextDocument, currentLine: number): number | undefined {
		const candidates = [currentLine - 1, currentLine + 1].filter((line) => line >= 0 && line < document.lineCount && document.lineAt(line).text.length >= 3);
		return candidates.length === 0 ? undefined : candidates[Math.floor(Math.random() * candidates.length)];
	}
	private renderImage(editor: vscode.TextEditor, image: CatImageOptions, range: vscode.Range): void {
		const key = `${image.action}/${image.frame}/${image.mirrored}/${image.scale}/${image.pixelOffsetX}/${image.pixelOffsetY}`;
		let decoration = this.costumes.get(key);
		if (!decoration) {
			const size = CAT_BASE_SIZE_PX * image.scale;
			const horizontalOffset = image.pixelOffsetX * image.scale;
			const verticalOffset = image.pixelOffsetY * image.scale;
			decoration = vscode.window.createTextEditorDecorationType({ after: { contentIconPath: createCatImage(this.extensionUri, image), width: `${size}px`, height: `${size}px`, margin: `${-size + verticalOffset}px ${-size - horizontalOffset}px 0 ${horizontalOffset}px` }, rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed });
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
		], { placeHolder: 'What should catUwU do after its current action?' });
		if (!choice) {return;}
		if (choice.value === 'jumpUp') {
			if (!cat.jump('up')) {void vscode.window.showInformationMessage('There is no line above for catUwU to jump to.');}
		} else if (choice.value === 'jumpDown') {
			if (!cat.jump('down')) {void vscode.window.showInformationMessage('There is no line below for catUwU to jump to.');}
		} else {cat.order(choice.value);}
	};
	context.subscriptions.push(vscode.commands.registerCommand('catuwu.summon', summon), vscode.commands.registerCommand('catuwu.action', chooseAction), vscode.window.onDidChangeTextEditorVisibleRanges(() => cat.render()), vscode.window.onDidChangeVisibleTextEditors(() => cat.render()), vscode.window.onDidChangeTextEditorViewColumn(() => cat.render()), vscode.workspace.onDidChangeTextDocument((event) => { cat.handleDocumentChange(event); cat.render(); }), new vscode.Disposable(() => cat.dispose()));
}
export function deactivate(): void {}
