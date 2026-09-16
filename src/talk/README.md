# Dialogue format

`talk.json` may be either an array of dialogue lines or an object with a `lines` array. Each line needs `text`; optional filters go in `filters` (or directly on the line).

```json
{
  "lines": [
    { "text": "Hello!" },
    { "text": "A TypeScript box!", "filters": { "language": "typescript" } },
    { "text": "Oh no!", "filters": { "when": "error", "error": true } },
    { "text": "That variable is unused.", "filters": { "when": "warning", "warning": true } },
    { "text": "Ready!", "when": ["summon", "action"] }
  ]
}
```

Filters can use a single value or an array:

- `when`: `summon`, `action`, `jump`, `error`, `warning`, `idle`, or `any` (`any` matches every trigger).
- `language`: a VS Code language ID such as `typescript`, `python`, or `plaintext`.
- `error`: `true` requires an error diagnostic; `false` requires no error diagnostic.
- `warning`: `true` requires a yellow warning diagnostic; `false` requires no warning diagnostic. Warnings include diagnostics such as an unused variable when the language extension reports it.

All specified filters must match. Lines without filters can be selected for any event.
