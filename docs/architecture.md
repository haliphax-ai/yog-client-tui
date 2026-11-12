# Architecture

The code is split into domains with enforced dependency rules
(dependency-cruiser in `npm run depcruise`). Each domain has one job and a
bounded set of things it may not touch.

| Domain           | Location           | Job                                                                                                                                       |
| ---------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Composition root | `src/main.ts`      | Wiring only: config loading, terminal lifecycle, key routing, render scheduling.                                                          |
| `config`         | `src/config.ts`    | Parse and validate `config.json`; resolve the config/state file locations.                                                                |
| `client`         | `src/yogClient.ts` | The yog HTTP/SSE transport: capabilities, sessions, turns, recovery.                                                                      |
| `core`           | `src/core/`        | The domain model: log entries, state store, focus ring, scroll math, transcript conversion, the turn presenter, slash-command vocabulary. |
| `ui`             | `src/ui/`          | Everything drawn: components, the render pipeline, the table engine, the theme.                                                           |
| `util`           | `src/util/`        | ANSI cell math and fuzzy matching. A leaf: imports nothing from other domains.                                                            |

## The rules

- `main.ts` is the only module allowed to import `config/`.
- `client/` never touches the terminal, styling, config, or the filesystem.
- `ui/` never imports the transport or the filesystem, and reads application
  state only through the store.
- `core/` never imports `ui/`: the domain owns the shape of the data, the UI
  owns how it looks.
- Within `ui/`, `render/` never imports `components/`.

These constraints are what let the presentation and the transport change
independently. Change the renderer without touching the client; swap the
client without touching the renderer.

## The state store

`core/store.ts` holds the application state (entries, input text, focus,
scroll, token totals) behind `getState` / `setState` / `subscribe`. Every
mutation goes through `setState`, which notifies subscribers; the render
scheduler is the one subscriber that matters.

## The turn presenter

`core/turnPresenter.ts` translates SSE turn events into store updates: no
rendering, no terminal access. It shares entry builders with transcript
rehydration, so a rehydrated row renders exactly like a live one.

## Where things live

- `src/core/entries.ts` holds the log-entry shape (`LogEntry`, kinds, and
  the per-table interaction state).
- `src/core/transcript.ts` converts server transcript rows to display
  entries. It is pure and lossless: every row maps to an entry, and
  malformed rows are skipped defensively rather than aborting conversion.
- `src/core/commands.ts` is the slash-command registry (name, summary,
  optional args).
- `src/util/ansi.ts` provides `displayWidth`, `stripAnsi`, `sliceAnsi`,
  `wrapText`, and `truncateAnsi`. Widths are always measured in terminal
  cells, never characters; see AGENTS.md for the full rule and the history
  behind it.
