# catUwU

`catUwU: Summon` places a cat on the selected line in Auto mode. `catUwU: Choose Action` opens the order menu; the cat completes its current walk or blink before obeying. Auto mode alternates walking to a line end with sitting for a blink cycle.

## Colours and blinking

`catuwu.eyeColor`, `catuwu.eyelidColor`, and `catuwu.maskColor` accept six-digit hex colours. Every pixel in a sprite matching `maskColor` is rendered as the eye or eyelid colour selected by that animation frame. Changes apply to the summoned cat immediately.

The bundled sprites use `#22B14C` for the mask. When adding artwork, paint every recolourable eye or lid pixel with that mask colour; do not use it elsewhere in the sprite.

## Adding actions

Actions live in `src/actions.ts`. Each action is a small factory function (`sit`, `walk`) that supplies initial state, a frame, a position, and its next-frame timing. `stageAction` and `advanceAction` centralize how actions begin and move. Add a function such as `jump` or `climb`, then register it in `CAT_ACTIONS`; it will automatically appear in the action picker.

`createCatImage` in `src/extension.ts` is the sprite factory. Pass an action, frame index, mirror flag, eye state, and scale to receive the rendered image URI.
