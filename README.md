# yog-client-tui

A minimal terminal chat client for yog-style HTTP/SSE servers, built with Node.js
and TypeScript. It opens a session, streams assistant replies into a scrollable log
viewport, and keeps a bounded conversation transcript so the server — which has no
per-session memory — can still see recent context on every turn. Terminal styling is
provided by the `charsm` WASM library (lipgloss-style primitives).

## Architecture

The code is split into three strictly separated concerns:

| Module | Responsibility |
|---|---|
| `src/config.ts` | Config parsing and validation: `model` (required), optional `baseUrl`, and `resolveBaseUrl` (config → `YOG_SERVER_URL` env → `http://127.0.0.1:8111`). |
| `src/yogClient.ts` | The yog HTTP/SSE client: capabilities probe → `POST /v1/sessions` → `POST /v1/sessions/{id}/turns` with `{prompt, model}` → SSE event consumption → turn-status recovery → `DELETE session` on exit. |
| `src/view.ts` | Presentation only. Renders the log viewport + input bar + status line via charsm (`initLip` / `Lipgloss` / `createStyle` / `apply` / `join`). |
| `src/main.ts` | Wiring: terminal lifecycle (alt screen, raw mode), key handling, scroll state, render coalescing, and the bounded client-side transcript. |

`view.ts` never talks to the network and `yogClient.ts` never touches the terminal,
so the presentation layer can change without affecting transport logic (and vice
versa).

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
| `Enter` | Send the current input (on a focused chunk: expand/collapse it) |
| `Ctrl+C` | Quit |
| `←` / `→`, `Home` / `End`, `Backspace` / `Delete` | Edit input |
| `PageUp` / `PageDown`, `↑` / `↓` | Scroll the log viewport |
| `Ctrl+Home` / `Ctrl+End` | Jump to top / bottom of the log |
| `Tab` | Focus the next log entry (cycle) |
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