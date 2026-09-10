import * as vscode from 'vscode';

const FRAME_DURATION_MS = 100;
const CAT_SCALE = 3;
const CAT_BASE_SIZE_PX = 69;
const CAT_SIZE_PX = CAT_BASE_SIZE_PX * CAT_SCALE;

/**
 * The order of the sitting animation is deliberate. Do not derive it from
 * filenames: the source assets are not consecutively numbered.
 */
const SIT_COSTUME_FILES = ['CatSit0.png', 'CatSit1.png', 'CatSit3.png'] as const;

/** Converts a command argument to a positive, one-based editor line number. */
export function toPositiveLineNumber(input: unknown): number | undefined {
	try {
		const number = Number(input);
		if (!Number.isFinite(number)) {
			return undefined;
		}

		return Math.max(1, Math.abs(Math.trunc(number)));
	} catch {
		return undefined;
	}
}

class SittingCat {
	private readonly costumes: readonly vscode.TextEditorDecorationType[];
	private targetLine: number | undefined;
	private frameIndex = 0;
	private renderedEditor: vscode.TextEditor | undefined;
	private renderedFrameIndex: number | undefined;

	public constructor(extensionUri: vscode.Uri) {
		this.costumes = SIT_COSTUME_FILES.map((costumeFile) =>
			vscode.window.createTextEditorDecorationType({
				// Anchoring to the requested line makes VS Code move the cat as it scrolls.
				// `after` paints after the editor glyphs, keeping the cat frontmost.
				after: {
					contentIconPath: vscode.Uri.joinPath(extensionUri, 'src', 'animation', 'sit', costumeFile),
					width: `${CAT_SIZE_PX}px`,
					height: `${CAT_SIZE_PX}px`,
					// The negative top/right margins cancel this attachment's layout
					// footprint. Its bottom edge meets the top edge of the requested line,
					// without moving the code or changing the line's height.
					margin: `-${CAT_SIZE_PX}px -${CAT_SIZE_PX}px 0 0`,
				},
				rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
			}),
		);
	}

	public showOnLine(line: number): void {
		this.targetLine = line;
		this.frameIndex = 0;
		this.render();
	}

	public advanceFrame(): void {
		if (this.targetLine === undefined) {
			return;
		}

		this.frameIndex = (this.frameIndex + 1) % this.costumes.length;
		this.render();
	}

	public render(): void {
		if (this.targetLine === undefined) {
			this.clearRenderedCostume();
			return;
		}

		const editor = this.leftmostVisibleEditor();
		const zeroBasedLine = this.targetLine - 1;
		if (!editor || zeroBasedLine >= editor.document.lineCount || !this.isLineVisible(editor, zeroBasedLine)) {
			this.clearRenderedCostume();
			return;
		}

		this.clearRenderedCostume();
		const position = new vscode.Position(zeroBasedLine, 0);
		editor.setDecorations(this.costumes[this.frameIndex], [new vscode.Range(position, position)]);
		this.renderedEditor = editor;
		this.renderedFrameIndex = this.frameIndex;
	}

	public dispose(): void {
		this.clearRenderedCostume();
		for (const costume of this.costumes) {
			costume.dispose();
		}
	}

	private leftmostVisibleEditor(): vscode.TextEditor | undefined {
		return vscode.window.visibleTextEditors
			.map((editor, index) => ({ editor, index }))
			.sort((first, second) => {
				const firstColumn = first.editor.viewColumn ?? Number.MAX_SAFE_INTEGER;
				const secondColumn = second.editor.viewColumn ?? Number.MAX_SAFE_INTEGER;
				return firstColumn - secondColumn || first.index - second.index;
			})[0]?.editor;
	}

	private isLineVisible(editor: vscode.TextEditor, line: number): boolean {
		return editor.visibleRanges.some((visibleRange) =>
			visibleRange.start.line <= line && line <= visibleRange.end.line,
		);
	}

	private clearRenderedCostume(): void {
		if (!this.renderedEditor || this.renderedFrameIndex === undefined) {
			return;
		}

		this.renderedEditor.setDecorations(this.costumes[this.renderedFrameIndex], []);
		this.renderedEditor = undefined;
		this.renderedFrameIndex = undefined;
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const cat = new SittingCat(context.extensionUri);

	const sitOnLine = async (input?: unknown): Promise<void> => {
		let lineNumber = toPositiveLineNumber(input);
		if (lineNumber === undefined) {
			const response = await vscode.window.showInputBox({
				prompt: 'Line number for the sitting cat',
				placeHolder: 'A positive line number',
				validateInput: (value) => toPositiveLineNumber(value) === undefined
					? 'Enter a finite number.'
					: undefined,
			});
			if (response === undefined) {
				return;
			}
			lineNumber = toPositiveLineNumber(response);
		}

		if (lineNumber !== undefined) {
			cat.showOnLine(lineNumber);
		}
	};

	const animation = setInterval(() => cat.advanceFrame(), FRAME_DURATION_MS);
	context.subscriptions.push(
		vscode.commands.registerCommand('catuwu.summon', sitOnLine),
		vscode.window.onDidChangeTextEditorVisibleRanges(() => cat.render()),
		vscode.window.onDidChangeVisibleTextEditors(() => cat.render()),
		vscode.window.onDidChangeTextEditorViewColumn(() => cat.render()),
		vscode.workspace.onDidChangeTextDocument(() => cat.render()),
		new vscode.Disposable(() => clearInterval(animation)),
		new vscode.Disposable(() => cat.dispose()),
	);
}

export function deactivate(): void {}
