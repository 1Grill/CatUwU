import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';

const CAT_SCALE = 2;
const CAT_BASE_SIZE_PX = 24;
const CAT_SIZE_PX = CAT_BASE_SIZE_PX * CAT_SCALE;

const SIT_OPEN = 'CatSit0.png';
const SIT_BLINK_FRAMES = ['CatSit1.png', 'CatSit3.png', 'CatSit1.png', SIT_OPEN] as const;
const WALK_FRAMES = ['Catwalk0.png', 'CatWalk1.png'] as const;

type CatAction = 'sit' | 'walk';
type Direction = -1 | 1;

interface Costume {
	directory: 'sit' | 'walk';
	file: string;
	mirrored: boolean;
}

/** Return a number between min and max, including both endpoints. */
function randomBetween(min: number, max: number): number {
	return min + Math.random() * (max - min);
}

/**
 * VS Code renders PNG decoration icons at their intrinsic size. Embedding each
 * costume in an SVG gives it a scaled native size and lets us flip it without
 * maintaining duplicate left/right image files.
 */
function scaledCostumeUri(extensionUri: vscode.Uri, costume: Costume): vscode.Uri {
	const pngUri = vscode.Uri.joinPath(extensionUri, 'src', 'animation', costume.directory, costume.file);
	const pngBase64 = readFileSync(pngUri.fsPath).toString('base64');
	const flip = costume.mirrored
		? ` transform="translate(${CAT_BASE_SIZE_PX} 0) scale(-1 1)"`
		: '';
	const svg = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${CAT_SIZE_PX}" height="${CAT_SIZE_PX}" viewBox="0 0 ${CAT_BASE_SIZE_PX} ${CAT_BASE_SIZE_PX}">`,
		`<image href="data:image/png;base64,${pngBase64}" width="${CAT_BASE_SIZE_PX}" height="${CAT_BASE_SIZE_PX}" image-rendering="pixelated"${flip}/>`,
		'</svg>',
	].join('');

	return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

class Cat {
	private readonly costumes = new Map<string, vscode.TextEditorDecorationType>();
	private targetLine: number | undefined;
	private targetEditor: vscode.TextEditor | undefined;
	private action: CatAction = 'sit';
	private walkColumn = 0;
	private direction: Direction = 1;
	private walkFrameIndex = 0;
	private blinkFrameIndex = -1;
	private animationTimer: ReturnType<typeof setTimeout> | undefined;
	private renderedEditor: vscode.TextEditor | undefined;
	private renderedCostumeKey: string | undefined;

	public constructor(private readonly extensionUri: vscode.Uri) {}

	public summon(editor: vscode.TextEditor, action: CatAction): void {
		this.targetEditor = editor;
		const line = editor.selection.active.line + 1;
		this.targetLine = line;
		this.action = action;
		this.walkColumn = 0;
		this.direction = 1;
		this.walkFrameIndex = 0;
		this.blinkFrameIndex = -1;
		this.restartAnimation();
		this.render();
	}

	public render(): void {
		if (this.targetLine === undefined) {
			this.clearRenderedCostume();
			return;
		}

		const editor = this.targetEditor;
		const zeroBasedLine = this.targetLine - 1;
		if (!editor || !vscode.window.visibleTextEditors.includes(editor)
			|| zeroBasedLine >= editor.document.lineCount || !this.isLineVisible(editor, zeroBasedLine)) {
			this.clearRenderedCostume();
			return;
		}

		const column = this.action === 'walk'
			? Math.min(this.walkColumn, editor.document.lineAt(zeroBasedLine).text.length)
			: 0;
		const position = new vscode.Position(zeroBasedLine, column);
		this.renderCostume(editor, this.currentCostume(), new vscode.Range(position, position));
	}

	public dispose(): void {
		if (this.animationTimer !== undefined) {
			clearTimeout(this.animationTimer);
		}
		this.clearRenderedCostume();
		for (const costume of this.costumes.values()) {
			costume.dispose();
		}
	}

	private restartAnimation(): void {
		if (this.animationTimer !== undefined) {
			clearTimeout(this.animationTimer);
		}
		this.scheduleNextFrame(this.action === 'sit' ? randomBetween(1_500, 4_500) : randomBetween(90, 160));
	}

	private scheduleNextFrame(delay: number): void {
		this.animationTimer = setTimeout(() => this.advanceAnimation(), delay);
	}

	private advanceAnimation(): void {
		if (this.targetLine === undefined) {
			return;
		}

		if (this.action === 'sit') {
			this.advanceBlink();
		} else {
			this.advanceWalk();
		}
		this.render();
	}

	private advanceBlink(): void {
		this.blinkFrameIndex += 1;
		if (this.blinkFrameIndex < SIT_BLINK_FRAMES.length) {
			this.scheduleNextFrame(randomBetween(75, 125));
			return;
		}

		this.blinkFrameIndex = -1;
		this.scheduleNextFrame(randomBetween(1_800, 6_500));
	}

	private advanceWalk(): void {
		const editor = this.targetEditor;
		const lineIndex = (this.targetLine ?? 1) - 1;
		const lineLength = editor && lineIndex < editor.document.lineCount
			? editor.document.lineAt(lineIndex).text.length
			: 0;

		this.walkFrameIndex = (this.walkFrameIndex + 1) % WALK_FRAMES.length;
		if (lineLength === 0) {
			this.scheduleNextFrame(randomBetween(500, 1_000));
			return;
		}

		const nextColumn = this.walkColumn + this.direction;
		if (nextColumn < 0 || nextColumn > lineLength) {
			this.direction = this.direction === 1 ? -1 : 1;
			this.scheduleNextFrame(randomBetween(400, 900));
			return;
		}

		this.walkColumn = nextColumn;
		this.scheduleNextFrame(randomBetween(90, 160));
	}

	private currentCostume(): Costume {
		if (this.action === 'walk') {
			return {
				directory: 'walk',
				file: WALK_FRAMES[this.walkFrameIndex],
				// The rightward trip uses the horizontally mirrored source image.
				mirrored: this.direction === 1,
			};
		}

		return {
			directory: 'sit',
			file: this.blinkFrameIndex === -1 ? SIT_OPEN : SIT_BLINK_FRAMES[this.blinkFrameIndex],
			mirrored: false,
		};
	}

	private renderCostume(editor: vscode.TextEditor, costume: Costume, range: vscode.Range): void {
		const costumeKey = `${costume.directory}/${costume.file}/${costume.mirrored}`;
		let decoration = this.costumes.get(costumeKey);
		if (!decoration) {
			decoration = vscode.window.createTextEditorDecorationType({
				after: {
					contentIconPath: scaledCostumeUri(this.extensionUri, costume),
					width: `${CAT_SIZE_PX}px`,
					height: `${CAT_SIZE_PX}px`,
					// Keep the cat over the code without changing the line's layout.
					margin: `-${CAT_SIZE_PX}px -${CAT_SIZE_PX}px 0 0`,
				},
				rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
			});
			this.costumes.set(costumeKey, decoration);
		}

		editor.setDecorations(decoration, [range]);
		if (this.renderedEditor && this.renderedCostumeKey
			&& (this.renderedEditor !== editor || this.renderedCostumeKey !== costumeKey)) {
			this.renderedEditor.setDecorations(this.costumes.get(this.renderedCostumeKey)!, []);
		}

		this.renderedEditor = editor;
		this.renderedCostumeKey = costumeKey;
	}

	private isLineVisible(editor: vscode.TextEditor, line: number): boolean {
		return editor.visibleRanges.some((visibleRange) =>
			visibleRange.start.line <= line && line <= visibleRange.end.line,
		);
	}

	private clearRenderedCostume(): void {
		if (!this.renderedEditor || !this.renderedCostumeKey) {
			return;
		}
		this.renderedEditor.setDecorations(this.costumes.get(this.renderedCostumeKey)!, []);
		this.renderedEditor = undefined;
		this.renderedCostumeKey = undefined;
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const cat = new Cat(context.extensionUri);

	const summon = async (): Promise<void> => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			void vscode.window.showInformationMessage('Open an editor before summoning catUwU.');
			return;
		}

		const action = await vscode.window.showQuickPick([
			{ label: '$(debug-pause) Sit', value: 'sit' as const, description: 'Sit and blink on the current line' },
			{ label: '$(run) Walk', value: 'walk' as const, description: 'Walk back and forth across the current line' },
		], { placeHolder: 'What should catUwU do?' });
		if (!action) {
			return;
		}

		cat.summon(editor, action.value);
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('catuwu.summon', summon),
		vscode.window.onDidChangeTextEditorVisibleRanges(() => cat.render()),
		vscode.window.onDidChangeVisibleTextEditors(() => cat.render()),
		vscode.window.onDidChangeTextEditorViewColumn(() => cat.render()),
		vscode.workspace.onDidChangeTextDocument(() => cat.render()),
		new vscode.Disposable(() => cat.dispose()),
	);
}

export function deactivate(): void {}
