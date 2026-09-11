import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { advanceAction, CAT_ACTIONS, spriteFrame, stageAction, type ActionDefinition, type AnimationState, type CatAction, type EyeState } from './actions';
import { getCatPalette, isHexColor, type CatPalette } from './palette';

const CAT_SCALE = 2;
const CAT_BASE_SIZE_PX = 24;
export interface CatImageOptions {
	action: CatAction;
	frame: number;
	mirrored: boolean;
	eyeState: EyeState;
	scale: number;
}

/** Scale, mirror, and palette-replace a sprite without writing colour variants to disk. */
export function createCatImage(extensionUri: vscode.Uri, options: CatImageOptions, palette = getCatPalette()): vscode.Uri {
	const sprite = spriteFrame(options.action, options.frame);
	const pngUri = vscode.Uri.joinPath(extensionUri, 'src', 'animation', sprite.directory, sprite.file);
	const png = readFileSync(pngUri.fsPath);
	const pngBase64 = png.toString('base64');
	const flip = options.mirrored ? ` transform="translate(${CAT_BASE_SIZE_PX} 0) scale(-1 1)"` : '';
	const replacement = options.eyeState === 'eye' ? palette.eye : palette.eyelid;
	const pixels = recoloredMaskPixels(png, palette.mask, replacement);
	const svg = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${CAT_BASE_SIZE_PX * options.scale}" height="${CAT_BASE_SIZE_PX * options.scale}" viewBox="0 0 ${CAT_BASE_SIZE_PX} ${CAT_BASE_SIZE_PX}">`,
		`<g${flip}><image href="data:image/png;base64,${pngBase64}" width="${CAT_BASE_SIZE_PX}" height="${CAT_BASE_SIZE_PX}" image-rendering="pixelated"/>`,
		pixels, '</g>',
		'</svg>',
	].join('');
	return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

function hexToRgb(value: string): [number, number, number] {
	if (!isHexColor(value)) {return [0, 0, 0];}
	return [Number.parseInt(value.slice(1, 3), 16), Number.parseInt(value.slice(3, 5), 16), Number.parseInt(value.slice(5, 7), 16)];
}

/** Extract the small RGBA PNG's pixels and overlay only exact mask matches in SVG. */
function recoloredMaskPixels(png: Buffer, mask: string, replacement: string): string {
	if (!isHexColor(mask) || !isHexColor(replacement)) {return '';}
	const target = hexToRgb(mask);
	let offset = 8;
	let width = 0;
	let height = 0;
	const compressed: Buffer[] = [];
	while (offset < png.length) {
		const length = png.readUInt32BE(offset);
		const type = png.toString('ascii', offset + 4, offset + 8);
		const data = png.subarray(offset + 8, offset + 8 + length);
		if (type === 'IHDR') {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			if (data[8] !== 8 || data[9] !== 6) {return '';}
		} else if (type === 'IDAT') {compressed.push(data);}
		offset += length + 12;
	}
	const stride = width * 4;
	const raw = inflateSync(Buffer.concat(compressed));
	const pixels = Buffer.alloc(stride * height);
	let source = 0;
	for (let y = 0; y < height; y += 1) {
		const filter = raw[source++];
		const row = y * stride;
		for (let x = 0; x < stride; x += 1) {
			const value = raw[source++];
			const left = x >= 4 ? pixels[row + x - 4] : 0;
			const up = y > 0 ? pixels[row - stride + x] : 0;
			const upperLeft = y > 0 && x >= 4 ? pixels[row - stride + x - 4] : 0;
			pixels[row + x] = (value + pngFilterValue(filter, left, up, upperLeft)) & 0xff;
		}
	}
	const rectangles: string[] = [];
	for (let y = 0; y < height; y += 1) {for (let x = 0; x < width; x += 1) {
		const offset = (y * width + x) * 4;
		if (pixels[offset] === target[0] && pixels[offset + 1] === target[1] && pixels[offset + 2] === target[2] && pixels[offset + 3] === 255) {rectangles.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${replacement}"/>`);}
	}}
	return rectangles.join('');
}

function pngFilterValue(filter: number, left: number, up: number, upperLeft: number): number {
	if (filter === 0) {return 0;}
	if (filter === 1) {return left;}
	if (filter === 2) {return up;}
	if (filter === 3) {return Math.floor((left + up) / 2);}
	if (filter === 4) {
		const estimate = left + up - upperLeft;
		const [leftDistance, upDistance, upperLeftDistance] = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - upperLeft)];
		return leftDistance <= upDistance && leftDistance <= upperLeftDistance ? left : upDistance <= upperLeftDistance ? up : upperLeft;
	}
	return 0;
}

class Cat {
	private readonly costumes = new Map<string, vscode.TextEditorDecorationType>();
	private targetLine: number | undefined;
	private targetEditor: vscode.TextEditor | undefined;
	private action: CatAction = 'walk';
	private state: AnimationState = stageAction('walk', { column: 0, direction: 1 });
	private mode: 'auto' | 'ordered' = 'auto';
	private queuedActions: CatAction[] = [];
	private jumpTargetLine: number | undefined;
	private animationTimer: ReturnType<typeof setTimeout> | undefined;
	private renderedEditor: vscode.TextEditor | undefined;
	private renderedCostumeKey: string | undefined;

	public constructor(private readonly extensionUri: vscode.Uri) {}
	public summon(editor: vscode.TextEditor): void {
		this.targetEditor = editor;
		this.targetLine = editor.selection.active.line + 1;
		this.action = 'walk';
		this.state = stageAction('walk', { column: 0, direction: 1 });
		this.mode = 'auto';
		this.queuedActions = [];
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
		if (this.state.column <= lineLength) {return;}
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
		const context = { lineLength: editor.document.lineAt(line).text.length };
		const position = new vscode.Position(line, this.definition.column(this.state, context));
		const frame = this.definition.frame(this.state);
		this.renderImage(editor, { action: this.action, frame: this.state.frameIndex, mirrored: this.definition.mirrored(this.state), eyeState: frame.eyeState, scale: CAT_SCALE }, new vscode.Range(position, position));
	}
	public refreshPalette(): void {
		this.clearRenderedCostume();
		for (const costume of this.costumes.values()) {costume.dispose();}
		this.costumes.clear();
		this.render();
	}
	public dispose(): void {
		if (this.animationTimer !== undefined) {clearTimeout(this.animationTimer);}
		this.clearRenderedCostume();
		for (const costume of this.costumes.values()) {costume.dispose();}
	}
	private get definition(): ActionDefinition { return CAT_ACTIONS[this.action]; }
	private restartAnimation(): void {
		if (this.animationTimer !== undefined) {clearTimeout(this.animationTimer);}
		this.scheduleNextFrame(this.action === 'sit' ? randomBetween(1_500, 4_500) : randomBetween(90, 160));
	}
	private scheduleNextFrame(delay: number): void { this.animationTimer = setTimeout(() => this.advanceAnimation(), delay); }
	private advanceAnimation(): void {
		if (this.targetLine === undefined) {return;}
		const line = this.targetLine - 1;
		const lineLength = this.targetEditor && line < this.targetEditor.document.lineCount ? this.targetEditor.document.lineAt(line).text.length : 0;
		const step = advanceAction(this.action, this.state, { lineLength });
		this.render();
		if (step.complete) {
			this.animationTimer = setTimeout(() => {
				if (this.action === 'jumpUp' || this.action === 'jumpDown') {
					if (this.jumpTargetLine !== undefined) {this.targetLine = this.jumpTargetLine;}
					this.jumpTargetLine = undefined;
				}
				this.startNextAction();
			}, step.delay);
		} else {this.scheduleNextFrame(step.delay);}
	}
	private startNextAction(): void {
		const nextAction = this.queuedActions.shift() ?? (this.mode === 'auto' ? this.action === 'walk' ? 'sit' : 'walk' : this.action);
		this.action = nextAction;
		this.state = stageAction(nextAction, { column: this.state.column, direction: this.state.direction });
		this.render();
		this.restartAnimation();
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
		const palette = getCatPalette();
		const key = `${image.action}/${image.frame}/${image.eyeState}/${image.mirrored}/${image.scale}/${palette.eye}/${palette.eyelid}/${palette.mask}`;
		let decoration = this.costumes.get(key);
		if (!decoration) {
			const size = CAT_BASE_SIZE_PX * image.scale;
			decoration = vscode.window.createTextEditorDecorationType({ after: { contentIconPath: createCatImage(this.extensionUri, image, palette), width: `${size}px`, height: `${size}px`, margin: `-${size}px -${size}px 0 0` }, rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed });
			this.costumes.set(key, decoration);
		}
		editor.setDecorations(decoration, [range]);
		if (this.renderedEditor && this.renderedCostumeKey && (this.renderedEditor !== editor || this.renderedCostumeKey !== key)) {this.renderedEditor.setDecorations(this.costumes.get(this.renderedCostumeKey)!, []);}
		this.renderedEditor = editor;
		this.renderedCostumeKey = key;
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
	context.subscriptions.push(vscode.commands.registerCommand('catuwu.summon', summon), vscode.commands.registerCommand('catuwu.action', chooseAction), vscode.window.onDidChangeTextEditorVisibleRanges(() => cat.render()), vscode.window.onDidChangeVisibleTextEditors(() => cat.render()), vscode.window.onDidChangeTextEditorViewColumn(() => cat.render()), vscode.workspace.onDidChangeTextDocument((event) => { cat.handleDocumentChange(event); cat.render(); }), vscode.workspace.onDidChangeConfiguration((event) => { if (event.affectsConfiguration('catuwu')) {cat.refreshPalette();} }), new vscode.Disposable(() => cat.dispose()));
}
export function deactivate(): void {}
