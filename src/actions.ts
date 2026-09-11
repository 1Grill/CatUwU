export type Direction = -1 | 1;
export type EyeState = 'eye' | 'eyelid';
export type CatAction = 'sit' | 'walk';

export interface SpriteFrame { directory: string; file: string; eyeState: EyeState; }
export interface CatPosition { column: number; direction: Direction; }
export interface AnimationState extends CatPosition { frameIndex: number; cycles: number; stepsRemaining: number; }
export interface AnimationContext { lineLength: number; }
export interface AnimationStep { delay: number; complete: boolean; }
export interface ActionDefinition {
	label: string;
	description: string;
	initialState(position: CatPosition): AnimationState;
	advance(state: AnimationState, context: AnimationContext): AnimationStep;
	frame(state: AnimationState): SpriteFrame;
	column(state: AnimationState, context: AnimationContext): number;
	mirrored(state: AnimationState): boolean;
}

const SPRITES: Record<CatAction, readonly SpriteFrame[]> = {
	// Frames 0/1 are the tail positions; 2–4 are the quick blink sequence.
	sit: [
		{ directory: 'sit', file: 'CatSit0.png', eyeState: 'eye' },
		{ directory: 'sit', file: 'CatSit3.png', eyeState: 'eye' },
		{ directory: 'sit', file: 'CatSit1.png', eyeState: 'eyelid' },
		{ directory: 'sit', file: 'CatSit3.png', eyeState: 'eye' },
		{ directory: 'sit', file: 'CatSit1.png', eyeState: 'eyelid' },
	],
	walk: [
		{ directory: 'walk', file: 'Catwalk0.png', eyeState: 'eye' },
		{ directory: 'walk', file: 'CatWalk1.png', eyeState: 'eye' },
	],
};

/** The sprite selected by createCatImage. Frame indexes wrap for preview callers. */
export function spriteFrame(action: CatAction, frame: number): SpriteFrame {
	const frames = SPRITES[action];
	return frames[((frame % frames.length) + frames.length) % frames.length];
}

/** Create the state for an action without changing the cat's current position. */
export function stageAction(action: CatAction, position: CatPosition): AnimationState {
	return CAT_ACTIONS[action].initialState(position);
}

/** Advance any registered action through one tick. The controller owns scheduling this step. */
export function advanceAction(action: CatAction, state: AnimationState, context: AnimationContext): AnimationStep {
	return CAT_ACTIONS[action].advance(state, context);
}

/** Sit, swish the tail a few times, blink, then yield to the next staged action. */
export function sit(): ActionDefinition {
	return {
		label: '$(debug-pause) Sit', description: 'Sit, swish the tail, and blink',
		initialState: ({ column, direction }) => ({ frameIndex: 0, column, direction, cycles: 0, stepsRemaining: 0 }),
		advance: (state) => {
			if (state.frameIndex === 0) {
				state.frameIndex = 1;
				return { delay: randomBetween(350, 700), complete: false };
			}
			if (state.frameIndex === 1 && state.cycles < 2) {
				state.cycles += 1;
				state.frameIndex = 0;
				return { delay: randomBetween(400, 900), complete: false };
			}
			if (state.frameIndex === 1) { state.frameIndex = 2; return { delay: 100, complete: false }; }
			if (state.frameIndex === 2) { state.frameIndex = 3; return { delay: 90, complete: false }; }
			if (state.frameIndex === 3) { state.frameIndex = 4; return { delay: 90, complete: false }; }
			state.frameIndex = 0;
			return { delay: 550, complete: true };
		},
		frame: (state) => spriteFrame('sit', state.frameIndex),
		column: (state, { lineLength }) => Math.min(state.column, lineLength),
		mirrored: (state) => state.direction === 1,
	};
}

/** Walk a short, varied distance; do not make every walk span the whole line. */
export function walk(): ActionDefinition {
	return {
		label: '$(run) Walk', description: 'Walk a short distance',
		initialState: ({ column, direction }) => ({ frameIndex: 0, column, direction, cycles: 0, stepsRemaining: randomInteger(6, 16) }),
		advance: (state, { lineLength }) => {
			state.frameIndex = (state.frameIndex + 1) % SPRITES.walk.length;
			if (lineLength === 0 || state.stepsRemaining === 0) {return { delay: randomBetween(350, 700), complete: true };}
			const nextColumn = state.column + state.direction;
			if (nextColumn < 0 || nextColumn > lineLength) {
				state.direction = state.direction === 1 ? -1 : 1;
				return { delay: randomBetween(300, 600), complete: true };
			}
			state.column = nextColumn;
			state.stepsRemaining -= 1;
			return { delay: randomBetween(100, 180), complete: false };
		},
		frame: (state) => spriteFrame('walk', state.frameIndex),
		column: (state, { lineLength }) => Math.min(state.column, lineLength),
		mirrored: (state) => state.direction === 1,
	};
}

export const CAT_ACTIONS = { sit: sit(), walk: walk() } as const satisfies Record<CatAction, ActionDefinition>;
function randomBetween(min: number, max: number): number { return min + Math.random() * (max - min); }
function randomInteger(min: number, max: number): number { return Math.floor(randomBetween(min, max + 1)); }
