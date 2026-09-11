import * as vscode from 'vscode';

export interface CatPalette { eye: string; eyelid: string; mask: string; }
const DEFAULT_PALETTE: CatPalette = { eye: '#22B14C', eyelid: '#000000', mask: '#22B14C' };

/** Read the three sprite-colour settings in one place. */
export function getCatPalette(): CatPalette {
	const settings = vscode.workspace.getConfiguration('catuwu');
	return { eye: settings.get<string>('eyeColor', DEFAULT_PALETTE.eye), eyelid: settings.get<string>('eyelidColor', DEFAULT_PALETTE.eyelid), mask: settings.get<string>('maskColor', DEFAULT_PALETTE.mask) };
}

export function isHexColor(value: string): boolean { return /^#[0-9a-fA-F]{6}$/.test(value); }
