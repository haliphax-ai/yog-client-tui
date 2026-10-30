# AGENTS.md

## Width is measured in CELLS, never characters

Every width calculation in this codebase — column sizing, padding,
wrapping, truncation, slicing — must be expressed in **terminal cells**
(display columns), not string characters. A single emoji or other wide
rune is **one character but two cells**; CJK and several symbol blocks
behave the same way. Any code that mixes a character count into a
cell-based operation silently corrupts output for emoji-bearing text
(historically: columns misaligned by the marker count, and `"✅ Done"`
truncated to `"✅ Don"`).

The rule in practice:

- Measure with `displayWidth(...)` (wraps lipgloss `stringWidth`) — never
  `text.length`, `text.slice(n)`, or regex match lengths when the value
  feeds a layout decision.
- Strip styling before measuring visible content:
  `displayWidth(stripAnsi(text))`.
- Cut ANSI/OSC-bearing strings with `sliceAnsi(text, start, end)` —
  arguments are CELLS. `String.prototype.slice` shreds escape sequences
  as well as being character-based.
- Wrap with `wrapText(text, cols)` and truncate with
  `truncateAnsi(text, max)` — both cell-based.
- When a function hands you a count, check its unit before using it:
  `stripAnsi(...).length` is characters; `displayWidth(stripAnsi(...))`
  is cells. Only the second may drive padding, slicing, or column math.

If a new feature renders user- or model-supplied text, add a regression
test containing at least one emoji so a unit slip fails CI instead of
shipping.
