# UI

What the TUI draws and how.

## The render pipeline

Every frame passes through a fixed sequence of stages; the order is data
(the `STAGES` array in `src/ui/pipeline/stages.ts`), not convention, so it is
deterministic by construction:

| Stage     | Work                                                   | Hook point                                            |
| --------- | ------------------------------------------------------ | ----------------------------------------------------- |
| `layout`  | Measure terminal geometry into components.             | none                                                  |
| `paint`   | Each component renders its rows.                       | components and overlays that draw into the paint pass |
| `compose` | Pass-through; paint already joined the rows.           | hooks that rewrite the frame                          |
| `post`    | Pad or truncate every ANSI line to the terminal width. | overlays, status widgets, banners                     |
| `emit`    | Write the finished frame to stdout.                    | none                                                  |

Features extend the pipeline with `register(stage, hook)`: hooks append in
registration order (no priority numbers), each receives and returns the
current frame so later hooks see earlier hooks' output, and `register`
returns an unregister function. A hook-free pipeline is byte-identical,
frame for frame.

Frame coalescing lives in the pipeline too: the scheduler subscribes to the
state store once, collapses bursts of `setState` into one flush per
`FRAME_MS` window, and the flush runs the stages. The emit stage is the
single writer to stdout, and it diff-paints against the previous frame, so
an unchanged row is not rewritten.

## Components

`src/ui/components/` holds the pieces the paint stage draws:

- `ChatViewport` (a `ChatLogComponent` bound to the store) is the main log.
- `InputComponent` is the input bar, a bubbletea `TextArea` model
  underneath.
- `StatusComponent` draws the status line: model, session token totals,
  and the context-window gauge (when the server advertised one).
- `DrawerComponent` is a generic container above the input; children
  register in order via `drawerRegistry`. The `GeneratingComponent`
  spinner is its current child.
- `keyRouter` does focus-scoped key routing with a top-level ring between
  log and input; see [interaction](../interaction/index.md).

Components are terminal-free: they return rows and leave composition and
writing to the pipeline.

## Tables

A message containing a GFM pipe table is focusable, and every table in the
message is its own focus target (`Tab` walks the tables before moving to the
next message). The focused table draws blue borders, and its striped data
rows carry the focus blue while the others stay white.

The table engine (`src/ui/render/table/`) reshapes a table in a fixed order,
all widths in terminal cells:

1. Shrinkwrap every column to its content width.
2. If the table fits the viewport that way, it is done: rendered as-is, and
   `Enter` does nothing (there is nothing to expand).
3. Otherwise the available space (viewport minus borders and padding) is
   divided evenly among the columns, never giving a column more than its
   content needs.
4. If every column either fits its content or was given at least 30 cells,
   it is done, and `Enter` does nothing.
5. Otherwise the table is expandable. The current display is the collapsed
   one (it fits the viewport); `Enter` switches to the expanded one, where
   the squeezed columns are widened to at most 30 cells each. The expanded
   table may extend past the viewport; `←`/`→` (or `h`/`l`, `Home`/`End`)
   scroll it.

The 30-cell ceiling applies only to the expanded layout: a table that fits
when collapsed keeps its columns exactly as they are, and a column wider
than 30 cells is never shrunk below its own width. Expansion state and
scroll offset are tracked per table, so two tables in one message behave
independently.

## Theming

`src/ui/theme.ts` is the single source of color and padding styles
(lipgloss-based, tokyo-night palette). Renderers never hardcode colors; they
pull styles from the theme.

## Markdown and text

Prose renders through `@oakoliver/glamour` (markdown to terminal output,
memoized per wrap width), then normalization strips glamour's block
furniture so prose sits flush in the log. Tool bodies are hard-wrapped:
each source line is word-wrapped and JSON-highlighted to the block's body
width, so no row exceeds its budget and the terminal never soft-wraps a
chunk.
