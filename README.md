# yog-client-tui

A minimal terminal chat client for yog-style HTTP/SSE servers, built with Node.js
and TypeScript. It opens a session, streams assistant replies into a scrollable log
viewport, and keeps a bounded conversation transcript so the server — which has no
per-session memory — can still see recent context on every turn. Terminal styling is
provided by `@oakoliver/lipgloss` (a TypeScript port of charmbracelet/lipgloss)
with `@oakoliver/glamour` markdown rendering.

## Architecture

The code is split into responsibility domains with enforced dependency rules
(dependency-cruiser checks them in `npm run lint:deps`):

| Domain | Location | Responsibility |
|---|---|---|
| Composition root | `src/main.ts` | Wiring only: config loading, terminal lifecycle, key routing, render scheduling. The only module allowed to import `config/`. |
| `config` | `src/config.ts` | Config parsing and validation: `model` (required), optional `baseUrl`, and `resolveBaseUrl` (config → `YOG_SERVER_URL` env → `http://127.0.0.1:8111`). |
| `core` | `src/core/` | The tiny state store (`getState` / `setState` / `subscribe`), focus ring, bounded transcript history, scroll math, and the turn presenter (SSE events → state, no rendering). |
| `client` | `src/yogClient.ts` | The yog HTTP/SSE transport: capabilities probe → `POST /v1/sessions` → `POST /v1/sessions/{id}/turns` with `{prompt, model}` → SSE event consumption → turn-status recovery → `DELETE session` on exit. Never touches the terminal, styling, config, or the filesystem. |
| `ui` | `src/ui/` | Components (`ui/components`: base contract, chat log/viewport, input bar, status line, focus-scoped key router), presentation (`ui/render`: entry rendering, composition, memoized row cache), and the single theme source (`ui/theme.ts`). Talks to the store, never to the transport or filesystem. |
| `util` | `src/util/` | ANSI width / wrap / truncate helpers. A leaf domain: imports nothing from any other domain. |
| `ui/pipeline` | `src/ui/pipeline/` | The render pipeline: fixed stage runner, per-stage hook registry, store-backed frame scheduler, and the single frame writer. |

`client/` never touches the terminal and `ui/` never touches the transport, so
presentation can change without affecting transport logic (and vice versa).

### Render pipeline

Every redraw runs through a fixed sequence of stages — the order is data (the
`STAGES` array), not convention, so it is deterministic by construction:

| Stage | Core work | Hook point |
|---|---|---|
| `layout` | Measure terminal geometry (cols/rows/viewport rows) into components. | — |
| `paint` | Each component renders its rows. | components + overlays that draw into the paint pass |
| `compose` | Join viewport + input + status lines into one frame. | — |
| `post` | Pad/truncate every ANSI line to the terminal width. | overlays, status widgets, banners |
| `emit` | Write the finished frame to stdout — a single owner (`writeFrame`); nothing runs after it. | — |

Features extend the pipeline with `register(stage, hook)` from
`src/ui/pipeline/index.ts`: hooks append to an ordered array per stage and run
after that stage's core work, each receiving and returning the current frame so
later hooks always see earlier hooks' output. Ordering is registration order —
no priority numbers to reason about — and `register` returns an unregister
function. An empty hook list means the pipeline is exactly the core stages, so
hook-free rendering is byte-identical frame for frame.

Frame coalescing lives in the pipeline too: the scheduler subscribes to the state
store once, collapses bursts of `setState` into one flush per `FRAME_MS` window,
and the flush runs the stages.

## Setup

```sh
npm install
cp config.example.json config.json
# edit config.json and set your model id
npm start
```

`npm start` runs `node src/main.ts` directly (Node 22+ type-stripping; no build
step). `npm run typecheck` runs `tsc --noEmit`.

## Configuration

`config.json` is read from the current working directory, falling back to the
package root. See `config.example.json` for the committed template — a real
`config.json` is git-ignored.

| Key | Required | Description |
|---|---|---|
| `model` | yes | Model id sent with every turn. |
| `baseUrl` | no | Server base URL. |

Base URL resolution order: `baseUrl` from `config.json` → `YOG_SERVER_URL`
environment variable → `http://127.0.0.1:8111` (default).

If `config.json` is missing or invalid, the client exits with an error telling you
to run `cp config.example.json config.json`.

## Key bindings

| Key | Action |
|---|---|
| `Enter` | Send the current input (on a focused chunk / tool call: expand/collapse it) |
| `Ctrl+C` | Quit |
| `←` / `→`, `Home` / `End`, `Backspace` / `Delete` | Edit input |
| `PageUp` / `PageDown`, `↑` / `↓` | Scroll the log viewport |
| `Ctrl+Home` / `Ctrl+End` | Jump to top / bottom of the log |
| `Tab` | Focus the next expandable entry (tool call / output chunk; wraps through "none") |
| `Shift+Tab` | Focus the previous entry (wraps through "none") |
| `Esc` | Leave focus mode |

Input keystrokes are ignored while a turn is in flight (one turn at a time); the
status line shows a spinner and key hints.

## How it talks to yog

On each turn the client:

1. Probes server capabilities.
2. `POST /v1/sessions` to create a session (reused across turns).
3. `POST /v1/sessions/{id}/turns` with `{ prompt, model }`.
4. Consumes the SSE stream, rendering deltas into the assistant entry, tool
   call lines with an inline ✓/✗ indicator and syntax-highlighted args,
   collapsible (Tab + Enter) result chunks for tool output, and error events
   as they arrive.
5. If the stream drops, recovers the turn outcome from the turn-status endpoint
   (a "stream interrupted — turn recovered from turn status" note is logged).
6. `DELETE`s the session on exit.

**Note:** the server keeps no conversation memory. Each prompt is threaded with a
bounded transcript of recent `User:` / `Assistant:` exchanges so follow-up
questions still have context.

Default server: `http://127.0.0.1:8111`.