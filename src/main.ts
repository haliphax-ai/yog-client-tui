/**
 * Entry point / wiring only: terminal lifecycle, key handling, scroll state,
 * render scheduling, and the config → yogClient → presenter → view pipeline.
 *
 * Key bindings (also documented in README):
 *   Enter            submit (ignored while a turn is in flight)
 *   Ctrl+C           quit (restores the terminal, closes the session)
 *   Left/Right       move the input cursor
 *   Home/End         input cursor to start/end
 *   Backspace/Delete delete before/at cursor
 *   PageUp/PageDown  scroll the log (stops auto-follow; PageDown at the
 *                    bottom resumes it)
 *   Ctrl+Home/Ctrl+End  jump to top/bottom of the log (End resumes follow)
 *   Up/Down          scroll the log by one row
 *   Tab / Shift-Tab focus the next/previous expandable tool chunk — Enter
 *                    expands/collapses it, Esc leaves focus mode (focus wraps
 *                    through "none" at either end)
 */
import { loadConfig, resolveBaseUrl } from "./config.ts";
import { FOCUS_NONE, moveFocus as nextFocusIndex } from "./core/focus.ts";
import { buildPrompt, type HistoryMessage } from "./core/history.ts";
import { clampScroll, jump as jumpScroll, scrollBy as applyScrollBy } from "./core/scroll.ts";
import { createTurnPresenter } from "./core/turnPresenter.ts";
import { YogClient } from "./yogClient.ts";
import { displayWidth } from "./util/ansi.ts";
import {
  render,
  totalRows,
  type LogEntry,
  type RenderState,
} from "./ui/render/index.ts";

/** Rows reserved below the log: input bar + status line. */
const STATUS_ROWS = 2;

/** Input prompt marker (also sizes the input window). */
const PROMPT = "you › ";

/** Busy spinner frames, animated in the status line while a turn runs. */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Render coalescing interval so SSE deltas do not flood stdout. */
const FRAME_MS = 16;

/** Terminal state shared with error paths (module scope, always in sync). */
let terminalActive = false;

/** Restore the terminal: leave the alternate screen, re-enable the cursor. */
function restoreTerminal(): void {
  if (!terminalActive) return;
  terminalActive = false;
  process.stdout.write("\x1b[?1049l\x1b[?25h");
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
}

function main(): void {
  // Non-TTY safety: fail fast with a clear message instead of crashing.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      "yog-client-tui requires an interactive terminal (stdin/stdout is not a TTY).\n",
    );
    process.exit(1);
  }

  void run().catch((err: unknown) => {
    restoreTerminal();
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

interface UiState {
  entries: LogEntry[];
  input: string;
  cursor: number;
  inputScroll: number;
  scrollOffset: number;
  follow: boolean;
  busy: boolean;
  busyFrame: number;
  connection: "connecting" | "connected" | "error";
  model: string;
  statusNote: string;
  /** Focused log entry (-1 = none); Enter toggles chunk collapse. */
  focusIndex: number;
}

async function run(): Promise<void> {
  // 1. Config.
  const config = await loadConfig();
  const baseUrl = resolveBaseUrl(config);

  // 2. Capabilities probe + session creation (before the screen is taken
  //    over, so startup failures print plainly and exit non-zero).
  const client = new YogClient(baseUrl);
  const caps = await client.probe();
  await client.open();

  // ---- state -------------------------------------------------------------
  const state: UiState = {
    entries: [
      {
        kind: "system",
        lines: [
          `connected to ${baseUrl} · contract ${caps.contractVersion} · ` +
            `${caps.models.length} model(s) · ${caps.tools.length} tool(s)`,
          `model ${config.model} · Ctrl+C quits`,
        ],
      },
    ],
    input: "",
    cursor: 0,
    inputScroll: 0,
    scrollOffset: 0,
    follow: true,
    busy: false,
    busyFrame: 0,
    connection: "connected",
    model: config.model,
    statusNote: "",
    focusIndex: FOCUS_NONE,
  };
  const history: HistoryMessage[] = [];
  let quitting = false;

  // ---- render scheduling -------------------------------------------------
  let renderTimer: NodeJS.Timeout | undefined;
  const scheduleRender = (): void => {
    if (renderTimer !== undefined) return;
    renderTimer = setTimeout(() => {
      renderTimer = undefined;
      draw();
    }, FRAME_MS);
  };

  /** Keep the cursor inside the visible input window. */
  const fitInput = (): void => {
    const markerW = displayWidth(PROMPT);
    const avail = Math.max(1, (process.stdout.columns ?? 80) - markerW);
    if (state.inputScroll > state.cursor) state.inputScroll = state.cursor;
    while (
      state.inputScroll < state.cursor &&
      displayWidth(state.input.slice(state.inputScroll, state.cursor)) > avail - 1
    ) {
      state.inputScroll += 1;
    }
  };

  /** Status line: busy spinner, note, model, session state, key hints. */
  const statusBody = (): string => {
    const parts: string[] = [];
    if (state.busy) parts.push(`${SPINNER[state.busyFrame % SPINNER.length]} thinking…`);
    if (state.statusNote !== "") parts.push(state.statusNote);
    parts.push(`model ${state.model}`);
    parts.push(state.connection === "connected" ? "session ok" : state.connection);
  parts.push("Tab focus · PgUp/PgDn scroll · Enter send · Ctrl+C quit");
    return parts.join("  ·  ");
  };

  /** Compose and write one frame. */
  const draw = (): void => {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    const viewportRows = Math.max(1, rows - STATUS_ROWS);
    const total = totalRows(state.entries, cols);
    const maxOffset = Math.max(0, total - viewportRows);
    clampScroll(state, maxOffset);
    fitInput();

    const view: RenderState = {
      entries: state.entries,
      scrollOffset: state.scrollOffset,
      viewportRows,
      cols,
      promptMarker: PROMPT,
      input: state.input,
      cursor: state.cursor,
      inputScroll: state.inputScroll,
      status: statusBody(),
      focusIndex: state.focusIndex,
      busy: state.busy ? SPINNER[state.busyFrame % SPINNER.length] : undefined,
    };
    const frame = render(view);
    process.stdout.write(`\x1b[H${frame.split("\n").join("\r\n")}`);
  };

  // ---- busy spinner ------------------------------------------------------
  let spinnerTimer: NodeJS.Timeout | undefined;
  const startSpinner = (): void => {
    if (spinnerTimer !== undefined) return;
    state.busy = true;
    spinnerTimer = setInterval(() => {
      state.busyFrame += 1;
      scheduleRender();
    }, 90);
  };
  const stopSpinner = (): void => {
    state.busy = false;
    if (spinnerTimer !== undefined) {
      clearInterval(spinnerTimer);
      spinnerTimer = undefined;
    }
  };

  // ---- log helpers -------------------------------------------------------
  const pushLines = (kind: LogEntry["kind"], lines: string[]): void => {
    state.entries.push({ kind, lines });
    scheduleRender();
  };

  // ---- turn submission ---------------------------------------------------
  const submit = (): void => {
    const input = state.input.trim();
    if (input === "" || state.busy) return; // one turn at a time (documented)

    const turn = createTurnPresenter(
      {
        entries: state.entries,
        append: pushLines,
        width: () => process.stdout.columns ?? 80,
        requestRender: scheduleRender,
      },
      history,
    );
    turn.begin(input);
    state.input = "";
    state.cursor = 0;
    state.inputScroll = 0;
    state.statusNote = "";
    state.follow = true;
    startSpinner();
    scheduleRender();

    void (async () => {
      try {
        const outcome = await client.runTurn(
          buildPrompt(history, input),
          config.model,
          turn.events,
        );
        if (!outcome.ok) {
          const detail = outcome.failure ?? outcome.error;
          if (detail) turn.fail(detail);
        }
      } catch (err) {
        turn.fail(err instanceof Error ? err.message : String(err));
        state.connection = "error";
      } finally {
        stopSpinner();
        turn.finish();
        scheduleRender();
      }
    })();
  };

  // ---- input editing -----------------------------------------------------
  const insert = (text: string): void => {
    // Strip control characters; keep everything printable.
    const clean = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
    if (clean === "") return;
    state.input = state.input.slice(0, state.cursor) + clean + state.input.slice(state.cursor);
    state.cursor += clean.length;
    scheduleRender();
  };

  const backspace = (): void => {
    if (state.cursor === 0) return;
    state.input = state.input.slice(0, state.cursor - 1) + state.input.slice(state.cursor);
    state.cursor -= 1;
    scheduleRender();
  };

  const del = (): void => {
    if (state.cursor >= state.input.length) return;
    state.input = state.input.slice(0, state.cursor) + state.input.slice(state.cursor + 1);
    scheduleRender();
  };

  const moveCursor = (delta: number): void => {
    state.cursor = Math.max(0, Math.min(state.input.length, state.cursor + delta));
    scheduleRender();
  };

  const setCursor = (pos: number): void => {
    state.cursor = Math.max(0, Math.min(state.input.length, pos));
    scheduleRender();
  };

  // ---- scrolling ---------------------------------------------------------
  /** Scroll the log by `delta` rows (positive = toward the bottom). */
  const scrollBy = (delta: number): void => {
    const rows = Math.max(1, (process.stdout.rows ?? 24) - STATUS_ROWS);
    const total = totalRows(state.entries, process.stdout.columns ?? 80);
    const maxOffset = Math.max(0, total - rows);
    applyScrollBy(state, delta, maxOffset);
    scheduleRender();
  };

  const jump = (top: boolean): void => {
    jumpScroll(state, top);
    scheduleRender();
  };

  // ---- focus (Tab cycles entries; Enter toggles a chunk) -----------------
  /** First visible row of entry `i` (same accounting as `totalRows`). */
  const entryRowStart = (i: number): number =>
    totalRows(state.entries.slice(0, i), process.stdout.columns ?? 80);

  /** Rows entry `i` occupies incl. its trailing separator (same accounting as `totalRows`). */
  const entryBlockRows = (i: number): number =>
    totalRows(state.entries.slice(i, i + 1), process.stdout.columns ?? 80);

  /** Keep the whole focused entry inside the viewport: above → align its
   *  top; below → bottom-align short entries, top-align tall ones (a block
   *  taller than the viewport must never be scrolled at from its middle). */
  const revealFocus = (): void => {
    if (state.focusIndex < 0) return;
    const rows = Math.max(1, (process.stdout.rows ?? 24) - STATUS_ROWS);
    const top = entryRowStart(state.focusIndex);
    const height = entryBlockRows(state.focusIndex);
    if (top < state.scrollOffset) {
      state.follow = false;
      state.scrollOffset = top;
    } else if (top + height > state.scrollOffset + rows) {
      state.follow = false;
      state.scrollOffset = Math.min(top, top + height - rows);
    }
  };

  /**
   * Tab / Shift-Tab: move focus forward (+1) or backward (-1) through the
   * focusable chunks (see `core/focus` for the wrap-through-none ring).
   */
  const moveFocus = (dir: 1 | -1): void => {
    state.focusIndex = nextFocusIndex(state.entries, state.focusIndex, dir);
    revealFocus();
    scheduleRender();
  };

  /** Enter on a focused entry: expand/collapse a chunk or tool call; otherwise submit. */
  const toggleFocused = (): boolean => {
    const entry = state.entries[state.focusIndex];
    if (entry?.kind === "chunk") {
      entry.collapsed = !entry.collapsed;
    } else if (entry?.kind === "tool") {
      entry.expanded = !entry.expanded;
    } else {
      return false;
    }
    revealFocus();
    scheduleRender();
    return true;
  };

  // ---- key handling ------------------------------------------------------
  const SEQUENCES: { seq: string; run: () => void }[] = [
    { seq: "\x1b[Z", run: () => moveFocus(-1) }, // Shift+Tab → previous chunk
    { seq: "\x1b[1;5H", run: () => jump(true) }, // Ctrl+Home → top
    { seq: "\x1b[1;5F", run: () => jump(false) }, // Ctrl+End → bottom
    { seq: "\x1b[5~", run: () => scrollBy(-(process.stdout.rows ?? 24)) }, // PageUp
    { seq: "\x1b[6~", run: () => scrollBy(process.stdout.rows ?? 24) }, // PageDown
    { seq: "\x1b[3~", run: () => del() }, // Delete
    { seq: "\x1b[1~", run: () => setCursor(0) }, // Home (rxvt)
    { seq: "\x1b[4~", run: () => setCursor(state.input.length) }, // End (rxvt)
    { seq: "\x1b[H", run: () => setCursor(0) }, // Home
    { seq: "\x1b[F", run: () => setCursor(state.input.length) }, // End
    { seq: "\x1bOH", run: () => setCursor(0) },
    { seq: "\x1bOF", run: () => setCursor(state.input.length) },
    { seq: "\x1bOA", run: () => scrollBy(-1) }, // Up
    { seq: "\x1bOB", run: () => scrollBy(1) }, // Down
    { seq: "\x1bOC", run: () => moveCursor(1) }, // Right (application mode)
    { seq: "\x1bOD", run: () => moveCursor(-1) }, // Left (application mode)
    { seq: "\x1b[A", run: () => scrollBy(-1) }, // Up
    { seq: "\x1b[B", run: () => scrollBy(1) }, // Down
    { seq: "\x1b[C", run: () => moveCursor(1) }, // Right
    { seq: "\x1b[D", run: () => moveCursor(-1) }, // Left
  ];

  const handleData = (chunk: string): void => {
    let i = 0;
    while (i < chunk.length) {
      const rest = chunk.slice(i);
      const seq = SEQUENCES.find((s) => rest.startsWith(s.seq));
      if (seq) {
        seq.run();
        i += seq.seq.length;
        continue;
      }
      const cp = chunk.codePointAt(i);
      if (cp === undefined) break;
      const ch = String.fromCodePoint(cp);
      i += ch.length;
      if (ch === "\x03") {
        // Ctrl+C in raw mode: quit and restore the terminal.
        void quit(0);
        return;
      }
      if (ch === "\t") {
        moveFocus(1);
        continue;
      }
      if (ch === "\x1b") {
        // Lone Esc (no sequence matched): leave focus mode.
        if (state.focusIndex !== FOCUS_NONE) {
          state.focusIndex = FOCUS_NONE;
          scheduleRender();
        }
        continue;
      }
      if (ch === "\r" || ch === "\n") {
        if (!toggleFocused()) submit();
        continue;
      }
      if (ch === "\x7f" || ch === "\x08") {
        backspace();
        continue;
      }
      if (ch < " ") continue; // ignore other control characters
      insert(ch);
    }
  };

  // ---- terminal lifecycle ------------------------------------------------
  const enterTerminal = (): void => {
    terminalActive = true;
    process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H");
    process.stdin.setEncoding("utf8");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", handleData);

    const onResize = (): void => {
      process.stdout.write("\x1b[2J\x1b[H");
      draw();
    };
    process.stdout.on("resize", onResize);
    process.on("SIGWINCH", onResize);
    process.on("SIGINT", () => void quit(0));
    process.on("SIGTERM", () => void quit(0));
  };

  /** Quit: restore the terminal, best-effort session close, then exit. */
  const quit = async (code: number): Promise<void> => {
    if (quitting) return;
    quitting = true;
    if (renderTimer !== undefined) clearTimeout(renderTimer);
    if (spinnerTimer !== undefined) clearInterval(spinnerTimer);
    restoreTerminal();
    await Promise.race([
      client.close().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    process.exit(code);
  };

  // 4. Take over the terminal and draw the first frame.
  enterTerminal();
  draw();
}

main();