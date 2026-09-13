export type Direction = -1 | 1;
export type CatAction = 'sit' | 'walk' | 'jumpUp' | 'jumpDown';

export interface SpriteFrame { directory: string; file: string; }
export interface CatPosition { direction: Direction; pixelOffsetX?: number; }
export interface AnimationState extends CatPosition { frameIndex: number; cycles: number; stepsRemaining: number; pixelOffsetX: number; pixelOffsetY: number; jumpOriginX?: number; }
/** All horizontal values are sprite pixels, not CSS pixels. */
export interface AnimationContext { lineLength: number; lineHeight: number; minPixelOffsetX?: number; maxPixelOffsetX?: number; }
export interface AnimationStep { delay: number; complete: boolean; }
export interface ActionDefinition {
	label: string;
	description: string;
	autoWeight: number;
	initialState(position: CatPosition): AnimationState;
	advance(state: AnimationState, context: AnimationContext): AnimationStep;
	mirrored(state: AnimationState): boolean;
}

const SPRITES: Record<CatAction, readonly SpriteFrame[]> = {
	sit: [
		{ directory: 'sit', file: 'left.png' },
		{ directory: 'sit', file: 'centerleft.png' },
		{ directory: 'sit', file: 'center.png' },
		{ directory: 'sit', file: 'centerright.png' },
		{ directory: 'sit', file: 'right.png' },
	],
	walk: [
		{ directory: 'walk', file: 'Catwalk0.png' },
		{ directory: 'walk', file: 'CatWalk1.png' },
	],
	jumpUp: [{ directory: 'jump', file: 'CatJumpUp.png' }, { directory: 'jump', file: 'CatJumpDown.png' }],
	jumpDown: [{ directory: 'jump', file: 'CatJumpDown.png' }, { directory: 'jump', file: 'CatJumpUp.png' }],
};
const SIT_FRAME_SEQUENCE = [0, 1, 2, 3, 4, 3, 2, 1] as const;
const PIXELS_PER_TEXT_COLUMN = 4;
const WALK_FRAME_PIXELS = 4;
const JUMP_STEPS = 10;
const JUMP_SIDEWAYS_PIXELS = 10;

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

/** Play the sitting frames in order; repeat them before yielding to the next action. */
export function sit(): ActionDefinition {
	return {
		label: '$(debug-pause) Sit', description: 'Sit and animate continuously',
		autoWeight: 3,
		initialState: ({ direction, pixelOffsetX = 0 }) => ({ frameIndex: 0, direction, cycles: 0, stepsRemaining: 0, pixelOffsetX, pixelOffsetY: 0 }),
		advance: (state) => {
			state.cycles = (state.cycles + 1) % SIT_FRAME_SEQUENCE.length;
			state.frameIndex = SIT_FRAME_SEQUENCE[state.cycles];
			return { delay: 210, complete: state.cycles === 0 };
		},
		mirrored: (state) => state.direction === 1,
	};
}

/** Walk a short, varied distance; do not make every walk span the whole line. */
export function walk(): ActionDefinition {
	return {
		label: '$(run) Walk', description: 'Walk a short distance',
		autoWeight: 2,
		initialState: ({ direction, pixelOffsetX = 0 }) => ({ frameIndex: 0, direction, cycles: 0, stepsRemaining: randomInteger(24, 64), pixelOffsetX, pixelOffsetY: 0 }),
		advance: (state, { lineLength, minPixelOffsetX = 0, maxPixelOffsetX }) => {
			const textWidth = lineLength * PIXELS_PER_TEXT_COLUMN;
			const lineWidth = Math.max(minPixelOffsetX, Math.min(textWidth, maxPixelOffsetX ?? textWidth));
			state.pixelOffsetX = Math.max(minPixelOffsetX, Math.min(lineWidth, state.pixelOffsetX));
			if (lineWidth === 0 || state.stepsRemaining === 0) {return { delay: randomBetween(350, 700), complete: true };}
			const nextOffset = state.pixelOffsetX + state.direction;
			if (nextOffset < minPixelOffsetX || nextOffset > lineWidth) {
				state.direction = state.direction === 1 ? -1 : 1;
				return { delay: randomBetween(300, 600), complete: true };
			}
			state.pixelOffsetX = nextOffset;
			state.stepsRemaining -= 1;
			state.frameIndex = Math.floor(Math.abs(state.pixelOffsetX) / WALK_FRAME_PIXELS) % SPRITES.walk.length;
			return { delay: 60, complete: false };
		},
		mirrored: (state) => state.direction === 1,
	};
}

/**
 * Make a short parabolic leap to the next line. The line itself is changed only
 * after the last frame, so the visual movement and the editor position agree.
 */
export function jump(direction: 'up' | 'down'): ActionDefinition {
	return {
		label: direction === 'up' ? '$(arrow-up) Jump Up' : '$(arrow-down) Jump Down',
		description: `Jump one line ${direction}`,
		autoWeight: 0,
		initialState: ({ direction: facing, pixelOffsetX = 0 }) => ({ frameIndex: 0, direction: facing, cycles: 0, stepsRemaining: 0, pixelOffsetX, pixelOffsetY: 0, jumpOriginX: pixelOffsetX }),
		advance: (state, { lineHeight, minPixelOffsetX = 0, maxPixelOffsetX }) => {
			const distance = Math.max(1, Math.round(lineHeight));
			state.cycles += 1;
			const progress = Math.min(1, state.cycles / JUMP_STEPS);
			const verticalDirection = direction === 'up' ? -1 : 1;
			const loft = Math.max(5, Math.round(distance * 0.32));
			state.pixelOffsetY = Math.round((verticalDirection * distance * progress) - (loft * Math.sin(Math.PI * progress)));
			const originX = state.jumpOriginX ?? state.pixelOffsetX;
			const targetX = originX + (state.direction * JUMP_SIDEWAYS_PIXELS);
			const maximum = maxPixelOffsetX ?? Number.POSITIVE_INFINITY;
			state.pixelOffsetX = Math.max(minPixelOffsetX, Math.min(maximum, Math.round(originX + ((targetX - originX) * progress))));
			state.frameIndex = progress < 0.55 ? 0 : 1;
			return { delay: 55, complete: state.cycles >= JUMP_STEPS };
		},
		mirrored: (state) => state.direction === 1,
	};
}

export const CAT_ACTIONS = { sit: sit(), walk: walk(), jumpUp: jump('up'), jumpDown: jump('down') } as const satisfies Record<CatAction, ActionDefinition>;
function randomBetween(min: number, max: number): number { return min + Math.random() * (max - min); }
function randomInteger(min: number, max: number): number { return Math.floor(randomBetween(min, max + 1)); }
