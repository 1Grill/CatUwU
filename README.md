# catUwU

`catUwU: Summon` places a cat on the selected line in Auto mode. `catUwU: Choose Action` opens the order menu; the cat completes its current walk, sit, or jump before obeying. Auto mode chooses between walking and sitting by weight, favoring whichever action has just repeated while retaining a chance to switch.

If edits shorten the cat's line, it walks back toward the remaining text. If that line is too short, it queues a jump to a nearby usable line instead.

## Adding actions

Actions live in `src/actions.ts`. Each action is a small factory function (`sit`, `walk`) that supplies initial state, a frame, a position, and its next-frame timing. `stageAction` and `advanceAction` centralize how actions begin and move. Add a function such as `jump` or `climb`, then register it in `CAT_ACTIONS`; it will automatically appear in the action picker.

`createCatImage` in `src/extension.ts` is the sprite factory. Pass an action, frame index, mirror flag, and scale to receive the rendered image URI.
