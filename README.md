# yog-client-tui

A minimal terminal chat client for yog-style HTTP/SSE servers, built with Node.js
and TypeScript. It opens a session, streams assistant replies into a scrollable log
viewport, and resumes where it left off: the server owns the canonical transcript,
so turns send only the new prompt and a relaunch rehydrates the whole conversation
from the server before the first prompt. Terminal styling is
provided by `@oakoliver/lipgloss` (a TypeScript port of charmbracelet/lipgloss)
with `@oakoliver/glamour` markdown rendering.

## Architecture

The code is split into responsibility domains with enforced dependency rules
(dependency-cruiser checks them in `npm run lint:deps`):

| Domain           | Location           | Responsibility                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composition root | `src/main.ts`      | Wiring only: config loading, terminal lifecycle, key routing, render scheduling. The only module allowed to import `config/`.                                                                                                                                                                                                                                                            |
| `config`         | `src/config.ts`    | Config parsing and validation: `model` (required), optional `baseUrl`, and `resolveBaseUrl` (config → `YOG_SERVER_URL` env → `http://127.0.0.1:8111`).                                                                                                                                                                                                                                   |
| `core`           | `src/core/`        | The tiny state store (`getState` / `setState` / `subscribe`), focus ring, scroll math, transcript conversion (server rows → display entries, `core/transcript`), and the turn presenter (SSE events → state, no rendering).                                                                                                                                                              |
| `client`         | `src/yogClient.ts` | The yog HTTP/SSE transport: capabilities probe → resume-or-create `POST /v1/sessions` → prompt-only `POST /v1/sessions/{id}/turns` with `{prompt, model}` → SSE event consumption → turn-status recovery → transcript rehydration (`GET /v1/sessions/{id}/transcript`). Sessions outlive the client: quit never deletes. Never touches the terminal, styling, config, or the filesystem. |
| `ui`             | `src/ui/`          | Components (`ui/components`: base contract, chat log/viewport, input bar, status line, focus-scoped key router), presentation (`ui/render`: entry rendering, composition, memoized row cache), and the single theme source (`ui/theme.ts`). Talks to the store, never to the transport or filesystem.                                                                                    |
| `util`           | `src/util/`        | ANSI width / wrap / truncate helpers. A leaf domain: imports nothing from any other domain.                                                                                                                                                                                                                                                                                              |
| `ui/pipeline`    | `src/ui/pipeline/` | The render pipeline: fixed stage runner, per-stage hook registry, store-backed frame scheduler, and the single frame writer.                                                                                                                                                                                                                                                             |

`client/` never touches the terminal and `ui/` never touches the transport, so
presentation can change without affecting transport logic (and vice versa).

### Render pipeline

Every redraw runs through a fixed sequence of stages — the order is data (the
`STAGES` array), not convention, so it is deterministic by construction:

| Stage     | Core work                                                                                  | Hook point                                          |
| --------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `layout`  | Measure terminal geometry (cols/rows/viewport rows) into components.                       | —                                                   |
| `paint`   | Each component renders its rows.                                                           | components + overlays that draw into the paint pass |
| `compose` | Join viewport + input + status lines into one frame.                                       | —                                                   |
| `post`    | Pad/truncate every ANSI line to the terminal width.                                        | overlays, status widgets, banners                   |
| `emit`    | Write the finished frame to stdout — a single owner (`writeFrame`); nothing runs after it. | —                                                   |

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

| Key       | Required | Description                                                                                                                                                                                                                                                                                                                           |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`   | yes      | Model id sent with every turn.                                                                                                                                                                                                                                                                                                        |
| `baseUrl` | no       | Server base URL.                                                                                                                                                                                                                                                                                                                      |
| `session` | no       | Session id to resume. Left empty (or absent) to create a fresh session. The client rewrites this key after every startup, so a relaunch automatically resumes the last session; use the `--new` flag (or clear the key) to start fresh. If the stored id no longer exists server-side, the client starts a new session automatically. |

Base URL resolution order: `baseUrl` from `config.json` → `YOG_SERVER_URL`
environment variable → `http://127.0.0.1:8111` (default).

If `config.json` is missing or invalid, the client exits with an error telling you
to run `cp config.example.json config.json`.

## Key bindings

| Key                                               | Action                                                                           |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `Enter`                                           | Send the current input (on a focused chunk / tool call: expand/collapse it; on a focused message containing a table: expand its reflowed columns) |
| `Ctrl+C`                                          | Quit                                                                             |
| `←` / `→`, `Home` / `End`, `Backspace` / `Delete` | Edit input (on a focused expanded table: scroll columns horizontally)            |
| `PageUp` / `PageDown`, `↑` / `↓`                  | Scroll the log viewport                                                          |
| `Ctrl+Home` / `Ctrl+End`                          | Jump to top / bottom of the log                                                  |
| `Tab`                                             | Focus the next expandable entry (tool call / output chunk / table message; wraps through "none") |
| `Shift+Tab`                                       | Focus the previous entry (wraps through "none")                                  |
| `Esc`                                             | Leave focus mode · abort the in-flight turn (idle → no-op)                       |

### Tables

Messages containing a GFM pipe table are focusable when the table engine had
to reflow a column to fit the viewport **and** could not give it at least 30
display cells. Focused tables draw heavy borders; `Enter` expands — reflow
still runs, but reflowed columns render at a 30-cell floor, letting the table
extend horizontally past the viewport; `←`/`→` (or `h`/`l`) scroll it.
Columns the reflow never reshaped are left alone, and tables that fit without
squeezing are never expandable.

Input keystrokes are ignored while a turn is in flight (one turn at a time); the
status line shows a spinner and key hints — including `Esc abort` while busy.
Esc with a focused entry only leaves focus mode; with nothing focused it aborts
the active turn via the server's `POST /v1/sessions/{id}/abort` endpoint: the
server kills the tool call in flight, closes the model stream, heals the
transcript, and settles the turn, and the TUI logs a `⏹ turn aborted` line.

## How it talks to yog

The server owns the canonical conversation. At startup the client:

1. Probes server capabilities and requires the `transcript` feature (a daemon
   without it is not running the current contract — the client exits with an
   error rather than compensating).
2. Resolves the session: `--session <id>` from the command line, else the
   `session` key in `config.json`, else a fresh session (`--new` forces a
   fresh one regardless). A resumable id is validated with
   `GET /v1/sessions/{id}`; a stale id (`unknown_session`) falls back to a
   fresh session with a one-line note.
3. Rehydrates the visible conversation from the server's transcript dump
   (`GET /v1/sessions/{id}/transcript`) — every message kind, full fidelity:
   tool calls render as the same rich, expandable entries a live turn
   produces, annotated with their results, before the first frame is drawn.
4. Persists the resolved session id into `config.json` so the next launch
   resumes automatically (a failed startup never overwrites the stored id).

On each turn the client then:

5. `POST /v1/sessions/{id}/turns` with `{ prompt, model }` only — the server
   hydrates prior context from its canonical transcript, so no history ever
   rides along (retries after a failed turn replay from the last turn
   boundary server-side).
6. Consumes the SSE stream, rendering deltas into the assistant entry, tool
   call lines with an inline ✓/✗ indicator and syntax-highlighted args,
   collapsible (Tab + Enter) result chunks for tool output, and error events
   as they arrive.
7. If the stream drops, recovers the turn outcome from the turn-status endpoint
   (a "stream interrupted — turn recovered from turn status" note is logged).
8. Esc (with nothing focused) aborts the active turn via
   `POST /v1/sessions/{id}/abort` — a `⏹ turn aborted` note is logged from
   the stream's terminal `turn.aborted` event.
9. On quit, keeps the session: the server's DELETE is a detach (status
   `open` → `dormant`) and the transcript is kept, so the next launch resumes
   where this one left off. Only a server-side purge (`DELETE ?purge=true`)
   or the 30-day retention prune truly ends a session.

Default server: `http://127.0.0.1:8111`.
