/**
 * Entry point / wiring only: terminal lifecycle, key handling, scroll state,
 * render scheduling, and the config → yogClient → view pipeline.
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
import { YogClient, type TurnEvents } from "./yogClient.ts";
import {
  displayWidth,
  initLipGloss,
  prettyArgs,
  render,
  resultPreview,
  resultStatus,
  totalRows,
  type LogEntry,
  type RenderState,
} from "./view.ts";

/** Rows reserved below the log: input bar + status line. */
const STATUS_ROWS = 2;

/** Bounded client-side transcript: 12 exchanges (user + assistant pairs). */
const HISTORY_MESSAGES = 24;

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

/** One message of the client-side transcript history. */
interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
}

async function run(): Promise<void> {
  // 1. Config.
  const config = await loadConfig();
  const baseUrl = resolveBaseUrl(config);

  // 2. Styling engine (friendly error if the WASM fails to load).
  await initLipGloss();

  // 3. Capabilities probe + session creation (before the screen is taken
  //    over, so startup failures print plainly and exit non-zero).
  const client = new YogClient({ ...config, baseUrl });
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
    focusIndex: -1,
  };
  const history: HistoryMessage[] = [];
  const assistant: { entry?: LogEntry } = {}; // holder avoids closure narrowing
  let assistantText = "";
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
    if (state.follow) state.scrollOffset = maxOffset;
    state.scrollOffset = Math.min(state.scrollOffset, maxOffset);
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

  /** Tool call id → its log entry, so results can annotate the call line. */
  const pendingToolCalls = new Map<string, LogEntry>();

  // ---- turn submission ---------------------------------------------------
  /** Build the prompt: bounded transcript context + the new input. */
  const buildPrompt = (input: string): string => {
    const recent = history.slice(-HISTORY_MESSAGES);
    if (recent.length === 0) return input;
    const blocks = recent.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`);
    blocks.push(`User: ${input}`);
    return blocks.join("\n\n");
  };

  const submit = (): void => {
    const input = state.input.trim();
    if (input === "" || state.busy) return; // one turn at a time (documented)

    history.push({ role: "user", text: input });
    pushLines("user", [input]);
    state.input = "";
    state.cursor = 0;
    state.inputScroll = 0;
    state.statusNote = "";
    assistant.entry = undefined;
    assistantText = "";
    state.follow = true;
    startSpinner();
    scheduleRender();

    const events: TurnEvents = {
      onDelta: (text) => {
        assistantText += text;
        const entry = (assistant.entry ??= { kind: "assistant", lines: [""], streaming: true });
        if (state.entries[state.entries.length - 1] !== entry) state.entries.push(entry);
        // Append to the last (possibly partial) paragraph, re-split on \n.
        const lines = entry.lines;
        const lastIdx = lines.length - 1;
        const merged = `${lines[lastIdx] ?? ""}${text}`;
        lines.splice(lastIdx, 1, ...merged.split("\n"));
        scheduleRender();
      },
      onToolCall: (id, name, args) => {
        const cols = process.stdout.columns ?? 80;
        const label = `⚙️ ${name || "tool"}`;
        const full =
          args === undefined || args === null
            ? undefined
            : prettyArgs(args, Number.MAX_SAFE_INTEGER, "pretty");
        // The rebuilt row (label + ✅ + space + args + 2 padding) must fit
        // cols exactly: reserve 3 cells for the check landing in the label.
        const argsCompact =
          full === undefined
            ? undefined
            : prettyArgs(args, Math.max(12, cols - displayWidth(label) - 3 - 1 - 2));
        const shown = argsCompact === undefined ? label : `${label} ${argsCompact}`;
        const entry: LogEntry = {
          kind: "tool",
          lines: [shown],
          label,
          argsCompact,
          full,
          expanded: false,
        };
        state.entries.push(entry);
        pendingToolCalls.set(id, entry);
        scheduleRender();
      },
      onToolResult: (id, name, ok, result, error) => {
        // Annotate the matching call line in place (no extra chat lines).
        const call = pendingToolCalls.get(id);
        if (call) {
          pendingToolCalls.delete(id);
          const suffix = ok ? " ✅" : ` ❌ ${error ?? "failed"}`;
          // Check goes into the label (before the args), keeping its position
          // across collapse/expand; rebuild the collapsed line around it.
          if (call.label !== undefined) {
            call.label = `${call.label}${suffix}`;
            call.lines[0] =
              call.argsCompact === undefined
                ? call.label
                : `${call.label} ${call.argsCompact}`;
          } else {
            call.lines[0] = `${call.lines[0] ?? ""}${suffix}`;
          }
        } else {
          pushLines("tool", [`${ok ? "✅" : "❌"} ${name || "tool"}${ok ? "" : ` ${error ?? "failed"}`}`]);
        }
        // The result itself: a tool-output block. Header carries the status
        // (one space after the arrow); body is [] for status-only results —
        // short blocks render full height, long ones stay collapsible.
        if (result !== undefined && result !== null) {
          const cols = process.stdout.columns ?? 80;
          const body = resultPreview(result, cols);
          const status = resultStatus(result);
          const arrow = status ? ` → ${status}` : " →";
          state.entries.push({
            kind: "chunk",
            lines: [`${name || "tool"}${arrow}`, ...body],
            collapsed: true,
          });
        }
        scheduleRender();
      },
      onError: (code, message) => {
        pushLines("error", [`${code}: ${message}`]);
      },
      onRecovered: () => {
        pushLines("system", ["stream interrupted — turn recovered from turn status"]);
      },
    };

    void (async () => {
      try {
        const outcome = await client.runTurn(buildPrompt(input), config.model, events);
        if (!outcome.ok) {
          const detail = outcome.failure ?? outcome.error;
          if (detail) pushLines("error", [detail]);
        }
      } catch (err) {
        pushLines("error", [err instanceof Error ? err.message : String(err)]);
        state.connection = "error";
      } finally {
        stopSpinner();
        if (assistant.entry) assistant.entry.streaming = false;
        if (assistantText !== "") history.push({ role: "assistant", text: assistantText });
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
    state.follow = false;
    state.scrollOffset = Math.max(0, Math.min(maxOffset, state.scrollOffset + delta));
    if (state.scrollOffset >= maxOffset) state.follow = true;
    scheduleRender();
  };

  const jump = (top: boolean): void => {
    if (top) {
      state.follow = false;
      state.scrollOffset = 0;
    } else {
      state.follow = true;
      state.scrollOffset = Number.MAX_SAFE_INTEGER;
    }
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

  /** Indices of focusable entries (tool calls + output chunks). */
  const focusableChunks = (): number[] =>
    state.entries.flatMap((e, i) => (e.kind === "chunk" || e.kind === "tool" ? [i] : []));

  /**
   * Tab / Shift-Tab: move focus forward (+1) or backward (-1) through the
   * focusable chunks. The ring wraps through the "nothing selected" state
   * (-1): past the last chunk lands on none (as does Shift-Tab from the
   * first), and the next press continues from that end.
   */
  const moveFocus = (dir: 1 | -1): void => {
    const targets = focusableChunks();
    if (targets.length === 0) {
      state.focusIndex = -1;
      scheduleRender();
      return;
    }
    const pos = targets.indexOf(state.focusIndex);
    if (pos === -1) {
      state.focusIndex =
        dir === 1 ? (targets[0] as number) : (targets[targets.length - 1] as number);
    } else if (dir === 1) {
      state.focusIndex = pos === targets.length - 1 ? -1 : (targets[pos + 1] as number);
    } else {
      state.focusIndex = pos === 0 ? -1 : (targets[pos - 1] as number);
    }
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
        if (state.focusIndex !== -1) {
          state.focusIndex = -1;
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
