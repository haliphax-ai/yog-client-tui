# Server connection

How the TUI finds, talks to, and recovers from the yog daemon.

## Configuration

The client reads one JSON file, `config.json`, from the first existing
location of:

1. `$XDG_CONFIG_HOME/yog-client-tui/config.json`
2. `$HOME/.yog-client-tui/config.json`
3. `./yog-client-tui/config.json`

| Key       | Required | Meaning                                             |
| --------- | -------- | --------------------------------------------------- |
| `model`   | yes      | Model id sent with every turn.                      |
| `baseUrl` | yes      | Server origin, for example `http://127.0.0.1:8111`. |

`config.example.json` in the repo root is the committed template; a real
`config.json` is git-ignored. Session state lives next to the config file in
`state.json` (one key: `lastSessionId`). A missing or malformed config file
is a startup error, not a fallback to defaults.

## Startup

The client does all server work before taking over the terminal, so startup
failures print plainly and exit non-zero:

1. Probe `GET /v1/capabilities?model={model}`. The server must advertise the
   `transcript` feature; a daemon without it is not running the current
   contract and the client exits with an error instead of compensating.
2. Resolve the session: `--session <id>` from the command line, else
   `lastSessionId` from `state.json`, else a fresh session (`--new` forces a
   fresh one). A resumable id is checked with a `session.get` message; a
   stale id (`unknown_session`) falls back to a fresh session with a note.
3. Rehydrate the visible conversation from the server's transcript dump
   (`transcript.get`). Every row maps to a display entry, including tool
   calls with their results, before the first frame is drawn. When the
   server captured per-turn usage, each restored turn also gets the same
   summary line a live turn shows, and the startup note includes the resumed
   context weight (the provider total when known, otherwise a tokenx
   estimate labeled `~`).
4. Persist the resolved session id to `state.json` so the next launch
   resumes automatically. A failed startup never overwrites the stored id.

## Turns

A turn sends only the new prompt in a `turn.start` message. The server owns
the canonical transcript and hydrates prior context itself, so no history
ever rides along, and a retry after a failed turn replays from the last turn
boundary on the server side.

Progress arrives on the session stream (`GET /v1/sessions/{id}/stream`):
assistant deltas stream into the log as they arrive, tool calls appear with
an inline indicator and syntax-highlighted args, and each tool result gets a
collapsible output chunk. Per-round token estimates show on the tool chunks;
the status bar's session total climbs once per round with the round's real
usage, and the terminal usage report replaces the provisional numbers with
the full-context totals.

One turn runs at a time: `Enter` is ignored while the spinner is up, though
editing keeps working.

## Recovery

- If the stream drops mid-turn, the client replays the turn's stored events
  from `turn.get` and logs a "recovered" note. The turn still reaches a
  terminal state.
- If the session id went away entirely (purged or retention-pruned), the
  turn restarts against a fresh session with a note, and the new id is
  persisted.
- On resume, a turn still marked `running` on the server starts the spinner,
  shows a "turn in flight" note, and polls the transcript until the turn
  settles. Quitting never deletes the session or aborts the in-flight turn:
  the hang-up is a detach, the server keeps running the turn, and the next
  launch rehydrates the result.

## Compaction commands

`/compact` and `/handoff` run server-side summary turns (via the
`compaction.run` message) and adopt the fresh session they produce; `/shake`
rewrites oversized tool args/results in place (`transcript.shake`, no model
call) and resets the status-bar total to the shrunken context estimate. All
three are refused politely while a turn is in flight, and refused outright
with an "unsupported command" error when the server does not advertise the
matching feature.
