# catUwU

`catUwU: Summon` places a cat on the selected line in Auto mode. `catUwU: Choose Action` starts the chosen action immediately, then returns to Auto mode when that action finishes. The action menu also contains Talk. The cat is kept on a visible editor line and within the visible horizontal range as you scroll, switch editor groups, or shorten a line. Jumps are bounded parabolic hops to an adjacent visible line, with a short movement in the direction the cat faces.

If edits shorten the cat's line, it walks back toward the remaining text. If that line is too short, it queues a jump to a nearby usable line instead.

## Adding actions

Actions live in `src/actions.ts`. Each action is a small factory function (`sit`, `walk`) that supplies initial state, a frame, a position, and its next-frame timing. `stageAction` and `advanceAction` centralize how actions begin and move. Add a function such as `jump` or `climb`, then register it in `CAT_ACTIONS`; it will automatically appear in the action picker.

`createCatImage` in `src/extension.ts` is the sprite factory. Pass an action, frame index, mirror flag, and scale to receive the rendered image URI.

## Dialogue

Talk in `catUwU: Choose Action` chooses a matching line. The cat also talks when summoned, ordered, jumping, when diagnostics first report an error, and occasionally while idle. Each line is typed into a compact rounded pixel-art bubble that always sits behind the cat.

`src/talk/talk.json` accepts either a `lines` object or an array. Set `catuwu.talkFile` to an absolute or workspace-relative JSON file to use and edit your own dialogue; leaving it empty uses the bundled file. A line has `text` and optional `filters`; supported filters are `when` (`summon`, `action`, `jump`, `error`, `idle`, or `any`), VS Code `language` IDs, and `error` (`true` or `false`). Values may be single values or arrays. For example:

```json
{ "text": "Rusty paws detected.", "filters": { "when": "error", "language": ["rust", "typescript"], "error": true } }
```
