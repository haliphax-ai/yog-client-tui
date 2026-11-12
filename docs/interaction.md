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
command. Commands run even while a turn is in flight (so `/quit` always
works), except `/new`, `/compact`, `/handoff`, and `/shake`, which wait for
an idle turn.

| Command               | Action                                                           |
| --------------------- | ---------------------------------------------------------------- |
| `/new`                | Start a fresh session with an empty chat log.                    |
| `/compact [guidance]` | Compact the session into a fresh summary transcript.             |
| `/handoff [guidance]` | Prepare a handoff document and start a fresh transcript.         |
| `/shake`              | Truncate oversized tool args/results in the transcript in place. |
| `/quit`               | Exit, leaving the session on the server.                         |

Fuzzy shortcut: `Enter` on a slash line that is not an exact command name
but has a fuzzy match runs the best match with no arguments, so `/q` quits.
When the line contains arguments the shortcut is disabled, so argument text
is never silently dropped; use `Tab` completion instead.

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
