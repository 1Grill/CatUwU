import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import * as vscode from 'vscode';

export type TalkTrigger = 'summon' | 'action' | 'jump' | 'error' | 'idle' | 'any';

export interface TalkFilters {
	/** One or more events that may cause this line. `any` matches every event. */
	when?: TalkTrigger | TalkTrigger[];
	/** VS Code language IDs, for example `typescript`, `python`, or `plaintext`. */
	language?: string | string[];
	/** Match only while diagnostics contain an error (or only while they do not). */
	error?: boolean;
}

export interface TalkLine extends TalkFilters {
	text: string;
	/** `filters` is the preferred home for conditions; top-level conditions also work. */
	filters?: TalkFilters;
}

export interface TalkContext {
	trigger: TalkTrigger;
	languageId: string;
	hasError: boolean;
}

interface TalkFile { lines: TalkLine[]; }

/** Read user-editable dialogue from the extension's `talk.json` file. */
export function loadTalkLines(extensionUri: vscode.Uri): TalkLine[] {
	const configuredPath = vscode.workspace.getConfiguration('catuwu').get<string>('talkFile', '').trim();
	const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
	const file = !configuredPath ? vscode.Uri.joinPath(extensionUri, 'src', 'talk', 'talk.json') : isAbsolute(configuredPath) ? vscode.Uri.file(configuredPath) : vscode.Uri.joinPath(workspaceUri ?? extensionUri, configuredPath);
	try {
		const parsed: unknown = JSON.parse(readFileSync(file.fsPath, 'utf8'));
		const lines = Array.isArray(parsed) ? parsed : isTalkFile(parsed) ? parsed.lines : [];
		return lines.filter(isTalkLine);
	} catch (error) {
		console.warn(`catUwU could not read ${file.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}

/** Pick one applicable line. Undefined means the trigger is intentionally silent. */
export function chooseTalkLine(lines: readonly TalkLine[], context: TalkContext): string | undefined {
	const matches = lines.filter((line) => matchesContext(line, context));
	return matches.length === 0 ? undefined : matches[Math.floor(Math.random() * matches.length)].text;
}

function matchesContext(line: TalkLine, context: TalkContext): boolean {
	const filters = { when: line.filters?.when ?? line.when, language: line.filters?.language ?? line.language, error: line.filters?.error ?? line.error };
	const when = list(filters.when);
	const languages = list(filters.language);
	return (when.length === 0 || when.includes('any') || when.includes(context.trigger))
		&& (languages.length === 0 || languages.includes(context.languageId))
		&& (filters.error === undefined || filters.error === context.hasError);
}

function list<T>(value: T | T[] | undefined): T[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
function isTalkFile(value: unknown): value is TalkFile { return typeof value === 'object' && value !== null && 'lines' in value && Array.isArray(value.lines); }
function isTalkLine(value: unknown): value is TalkLine { return typeof value === 'object' && value !== null && 'text' in value && typeof value.text === 'string' && value.text.trim().length > 0; }

export interface SpeechBubble {
	dataUri: string;
	width: number;
	height: number;
}

const PIXEL = 2;
const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;
const CHARACTER_ADVANCE = 6;
const LINE_ADVANCE = 9;
const PADDING = 3;
const BORDER = 2;

/**
 * Render a deliberately tiny bitmap font and a stepped, pixel-art bubble.
 * The bubble is sized from the complete line, so typing does not make it jump.
 */
export function createSpeechBubble(fullText: string, visibleCharacters: number, maximumColumns: number): SpeechBubble {
	const text = Array.from(fullText);
	const lines = wrapText(text, Math.max(8, maximumColumns));
	const visible = text.slice(0, Math.max(0, visibleCharacters));
	const visibleLines = wrapText(visible, Math.max(8, maximumColumns));
	const widest = Math.max(1, ...lines.map((line) => line.length));
	const insideWidth = (widest * CHARACTER_ADVANCE) - 1;
	const insideHeight = (lines.length * LINE_ADVANCE) - 2;
	const logicalWidth = insideWidth + (PADDING * 2) + (BORDER * 2);
	const bodyHeight = insideHeight + (PADDING * 2) + (BORDER * 2);
	const tailHeight = 6;
	const width = logicalWidth * PIXEL;
	const height = (bodyHeight + tailHeight) * PIXEL;
	const glyphs = visibleLines.flatMap((line, lineIndex) => Array.from(line).flatMap((character, characterIndex) => pixelGlyph(character, (BORDER + PADDING + (characterIndex * CHARACTER_ADVANCE)) * PIXEL, (BORDER + PADDING + (lineIndex * LINE_ADVANCE)) * PIXEL)));
	const corner = BORDER * PIXEL;
	const innerLeft = BORDER * PIXEL;
	const innerRight = width - innerLeft;
	const innerTop = BORDER * PIXEL;
	const innerBottom = (bodyHeight * PIXEL) - innerTop;
	const svg = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges">`,
		// A tiny nine-slice frame: stepped corners plus repeatable straight edges.
		`<path d="M${corner} 0H${width - corner}V${corner}H${width}V${(bodyHeight * PIXEL) - corner}H${width - corner}V${bodyHeight * PIXEL}H${corner}V${(bodyHeight * PIXEL) - corner}H0V${corner}H${corner}Z" fill="#201b2d"/>`,
		`<path d="M${innerLeft + corner} ${innerTop}H${innerRight - corner}V${innerTop + corner}H${innerRight}V${innerBottom - corner}H${innerRight - corner}V${innerBottom}H${innerLeft + corner}V${innerBottom - corner}H${innerLeft}V${innerTop + corner}H${innerLeft + corner}Z" fill="#fff7e8"/>`,
		`<path d="M${8 * PIXEL} ${bodyHeight * PIXEL}h${8 * PIXEL}v${2 * PIXEL}h${2 * PIXEL}v${2 * PIXEL}h${2 * PIXEL}v${2 * PIXEL}h-${14 * PIXEL}z" fill="#201b2d"/>`,
		`<path d="M${10 * PIXEL} ${bodyHeight * PIXEL}h${4 * PIXEL}v${2 * PIXEL}h${2 * PIXEL}v${2 * PIXEL}h-${8 * PIXEL}z" fill="#fff7e8"/>`,
		...glyphs,
		'</svg>',
	].join('');
	return { dataUri: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, width, height };
}

function wrapText(characters: readonly string[], columns: number): string[] {
	const words = characters.join('').split(/(\s+)/);
	const lines: string[] = [];
	let line = '';
	for (const word of words) {
		if (word.includes('\n')) {
			const parts = word.split('\n');
			line += parts.shift() ?? '';
			lines.push(line.trimEnd());
			line = parts.join('');
			continue;
		}
		if (line.length > 0 && line.length + word.length > columns) { lines.push(line.trimEnd()); line = word.trimStart(); }
		else { line += word; }
	}
	if (line.length > 0 || lines.length === 0) {lines.push(line.trimEnd());}
	return lines;
}

function pixelGlyph(character: string, x: number, y: number): string[] {
	const glyph = FONT[character.toUpperCase()] ?? FONT['?'];
	return glyph.flatMap((row, rowIndex) => Array.from(row).flatMap((pixel, columnIndex) => pixel === '#' ? [`<rect x="${x + (columnIndex * PIXEL)}" y="${y + (rowIndex * PIXEL)}" width="${PIXEL}" height="${PIXEL}" fill="#201b2d"/>`] : []));
}

const FONT: Record<string, readonly string[]> = {
	'A': ['.###.','#...#','#...#','#####','#...#','#...#','#...#'], 'B': ['####.','#...#','#...#','####.','#...#','#...#','####.'], 'C': ['.####','#....','#....','#....','#....','#....','.####'], 'D': ['####.','#...#','#...#','#...#','#...#','#...#','####.'], 'E': ['#####','#....','#....','####.','#....','#....','#####'], 'F': ['#####','#....','#....','####.','#....','#....','#....'], 'G': ['.####','#....','#....','#.###','#...#','#...#','.###.'], 'H': ['#...#','#...#','#...#','#####','#...#','#...#','#...#'], 'I': ['#####','..#..','..#..','..#..','..#..','..#..','#####'], 'J': ['..###','...#.','...#.','...#.','...#.','#..#.','.##..'], 'K': ['#...#','#..#.','#.#..','##...','#.#..','#..#.','#...#'], 'L': ['#....','#....','#....','#....','#....','#....','#####'], 'M': ['#...#','##.##','#.#.#','#...#','#...#','#...#','#...#'], 'N': ['#...#','##..#','#.#.#','#..##','#...#','#...#','#...#'], 'O': ['.###.','#...#','#...#','#...#','#...#','#...#','.###.'], 'P': ['####.','#...#','#...#','####.','#....','#....','#....'], 'Q': ['.###.','#...#','#...#','#...#','#.#.#','#..#.','.##.#'], 'R': ['####.','#...#','#...#','####.','#.#..','#..#.','#...#'], 'S': ['.####','#....','#....','.###.','....#','....#','####.'], 'T': ['#####','..#..','..#..','..#..','..#..','..#..','..#..'], 'U': ['#...#','#...#','#...#','#...#','#...#','#...#','.###.'], 'V': ['#...#','#...#','#...#','#...#','#...#','.#.#.','..#..'], 'W': ['#...#','#...#','#...#','#...#','#.#.#','##.##','#...#'], 'X': ['#...#','#...#','.#.#.','..#..','.#.#.','#...#','#...#'], 'Y': ['#...#','#...#','.#.#.','..#..','..#..','..#..','..#..'], 'Z': ['#####','....#','...#.','..#..','.#...','#....','#####'],
	'0': ['.###.','#...#','#..##','#.#.#','##..#','#...#','.###.'], '1': ['..#..','.##..','..#..','..#..','..#..','..#..','.###.'], '2': ['.###.','#...#','....#','...#.','..#..','.#...','#####'], '3': ['####.','....#','....#','.###.','....#','....#','####.'], '4': ['...#.','..##.','.#.#.','#..#.','#####','...#.','...#.'], '5': ['#####','#....','#....','####.','....#','....#','####.'], '6': ['.###.','#....','#....','####.','#...#','#...#','.###.'], '7': ['#####','....#','...#.','..#..','.#...','.#...','.#...'], '8': ['.###.','#...#','#...#','.###.','#...#','#...#','.###.'], '9': ['.###.','#...#','#...#','.####','....#','....#','.###.'],
	' ': ['.....','.....','.....','.....','.....','.....','.....'], '.': ['.....','.....','.....','.....','.....','.##..','.##..'], ',': ['.....','.....','.....','.....','.....','.##..','..#..'], '!': ['..#..','..#..','..#..','..#..','..#..','.....','..#..'], '?': ['.###.','#...#','...#.','..#..','..#..','.....','..#..'], "'": ['..#..','..#..','.#...','.....','.....','.....','.....'], ':': ['.....','.##..','.##..','.....','.##..','.##..','.....'], ';': ['.....','.##..','.##..','.....','.##..','..#..','.#...'], '-': ['.....','.....','.....','.###.','.....','.....','.....'], '+': ['.....','..#..','..#..','#####','..#..','..#..','.....'], '/': ['....#','...#.','...#.','..#..','.#...','.#...','#....'], '(': ['...#.','..#..','.#...','.#...','.#...','..#..','...#.'], ')': ['.#...','..#..','...#.','...#.','...#.','..#..','.#...'],
};
