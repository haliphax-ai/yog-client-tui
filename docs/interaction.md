# Interaction

Keys, the input bar, slash commands, and debug mode.

## The focus ring

The UI has a top-level focus ring with two targets: the chat log and the
text input. Keys go to whichever side holds the ring; while the log holds
it, unhandled keys are dropped (they never reach the input). While the log
holds the ring, the input is drawn blurred (dark grey text, a darker
cursor), so it is obvious where keypresses will land.

The ring moves with `Shift+Up` (input → log) and `Shift+Down` (log →
input). `Esc` returns to the input from the log when nothing is focused.

Within the log, `Tab`/`Shift+Tab` cycle the focusable units: user and
assistant messages, tool calls, output and debug chunks, and each table
inside a message (wrapping through "none"). `Enter` expands or collapses
the focused unit; on a focused table, `←`/`→` scroll its columns.

## Key bindings

| Key                                        | Action                                                                                                                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Enter`                                    | In the input: send. In the log: expand/collapse the focused unit.                                                                                                                                                   |
| `Shift+Enter`                              | Insert a newline in the input without sending.                                                                                                                                                                      |
| `Shift+Up` / `Shift+Down`                  | Move the ring between input and log.                                                                                                                                                                                |
| Arrows, `Home`/`End`, `Backspace`/`Delete` | In the input: the full textarea keymap, including word navigation (`Alt`/`Ctrl`+arrows) and multi-line caret movement. In the log: `↑`/`↓` scroll one row; on a focused expanded table, `←`/`→` scroll its columns. |
| `PageUp`/`PageDown`                        | In the log: scroll a page. In a multi-line input: page the caret.                                                                                                                                                   |
| `Ctrl+Home`/`Ctrl+End`                     | In the log: jump to top/bottom. In the input: jump to buffer start/end.                                                                                                                                             |
| `Tab`/`Shift+Tab`                          | In the log: cycle focusable units. In the input: complete a slash command.                                                                                                                                          |
| `T`/`Shift+T`                              | While a message with tables is focused: cycle its tables.                                                                                                                                                           |
| `Esc`                                      | In the log with something focused: leave focus mode. In the log with nothing focused: return to the input. In the input: abort the in-flight turn (idle → no-op).                                                   |
| `/quit`                                    | Quit via the slash command. `Ctrl+C` is unbound.                                                                                                                                                                    |

`Shift+Enter` is recognized from the CSI-u / Kitty, xterm
modifyOtherKeys, and `ESC[13;2~` encodings. A terminal configured not to
report modified keys cannot distinguish `Shift+Enter` from `Enter`.

## The input bar

A multi-line textarea that grows and shrinks with its content up to ten
lines and scrolls vertically beyond that. Content is capped at 5000
characters. Pasted text (bracketed paste) is inserted verbatim, including
newlines, and never submits. While a turn is in flight, `Enter` is ignored;
editing continues, and the drawer above the input shows a spinner with an
`Esc abort` hint.

The abort path sends the server's `turn.abort` message, which kills the
tool call in flight, closes the model stream, heals the transcript, and
settles the turn; the TUI logs a note with the cut-point token counts when
the provider reported usage before the cut.

## Slash commands

Type `/` as the very first character of the input line to open the
autocomplete menu; a slash anywhere else is ordinary text. `Tab` cycles
through and applies the highlighted match; `Enter` runs the completed
command.

The registry has two sources, merged by name at startup:

- **Local commands** — client-owned lifecycle (`/new`, `/quit`). They win
  on any name collision with a server advertisement (a server has no
  business naming client lifecycle commands; collisions are dropped with a
  startup note on stderr).
- **Server-advertised commands** — descriptors from the capabilities reply
  (see the daemon contract doc): the slash name, a one-line summary, an
  optional argument syntax (`<required>` vs `[optional]`), and the
  messages-channel `type` an invocation dispatches. A descriptor whose
  `message` is not in the server `messageTypes` is dropped with a startup
  note. A fully wired daemon advertises `/compact [guidance]`,
  `/handoff [guidance]`, and `/shake`.

Commands run even while a turn is in flight (so `/quit` always works),
except the ones the server marks `requiresIdle` (`/compact`, `/handoff`,
`/shake`) and `/new`, which wait for an idle turn. A command whose argument
syntax starts with `<` refuses to run without one (the no-args fuzzy
syntax starts with `<` refuses to run without one (the no-args fuzzy
shortcut skips it too), so it asks for its argument instead of
dispatching garbage.

### Local commands

| Command | Action                                        |
| ------- | --------------------------------------------- |
| `/new`  | Start a fresh session with an empty chat log. |
| `/quit` | Exit, leaving the session on the server.      |

### Server-advertised commands (fully wired daemon)

| Command               | Dispatches       | Action                                                   |
| --------------------- | ---------------- | -------------------------------------------------------- |
| `/compact [guidance]` | `compaction.run` | Compact the session into a fresh summary transcript.     |
| `/handoff [guidance]` | `compaction.run` | Prepare a handoff document and start a fresh transcript. |

Fuzzy shortcut: `Enter` on a slash line that is not an exact command name
but has a fuzzy match runs the best match with no arguments, so `/q` quits.
When the line contains arguments the shortcut is disabled, so argument text
is never silently dropped; use `Tab` completion instead. Every advertised
command is usable even without bespoke client handling — the reply prints
as a notice; `compaction.run` and `transcript.shake` get richer treatment
(session adoption + rehydration, token-total reset).

## Debug mode

Set `YOG_DEBUG=1` to enable client-side debug chunks. Without it, debug
diagnostics are not emitted at all: not to the log, and (because they are
never part of the session transcript) not rehydrated on a later resume.

The key logger is opt-in via `YOG_DEBUG_KEYS` and stays inert unless debug
mode is also on:

- `YOG_DEBUG_KEYS=1` adds every input key/char/paste diagnostic to the
  debug chunk stream.
- `YOG_DEBUG_KEYS=/path/to/file` also appends a hex dump of every raw input
  chunk to that file (`1` is shorthand for `/tmp/yog-client-keys.log`). The
  file never touches the terminal.

Debug chunks mirror tool-result chunks: focusable, collapsed to five body
lines by default, expandable with focus + `Enter`. Consecutive debug
messages merge into one chunk until a non-debug entry lands. An error that
escapes an async callback surfaces as a fatal-error notice; with debug mode
on, the full stack trace lands in a debug chunk before the client restores
the terminal and exits.
