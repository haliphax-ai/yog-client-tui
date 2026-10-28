/**
 * Entry point / wiring only: terminal lifecycle, key handling, render
 * scheduling, and the config → yogClient → presenter → view pipeline.
 * UI state lives in the central store (`core/store`); the render scheduler
 * subscribes to it once, coalesces bursts into one flush, and the flush runs
 * the staged render pipeline (`ui/pipeline`: layout → paint → compose → post
 * → emit). Mutations go through `setState`, which notifies subscribers.
 *
 * Key handling is focus-scoped: `keyRouter` offers each key to the focused
 * component first, then the remaining components, then the globals below.
 * The viewport, input bar, and status line are components (`ui/components`);
 * the pipeline's paint stage renders their rows and emit writes the frame.
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
import { FOCUS_NONE } from "./core/focus.ts";
import { buildPrompt, type HistoryMessage } from "./core/history.ts";
import { getState, setState } from "./core/store.ts";
import { createTurnPresenter } from "./core/turnPresenter.ts";
import { YogClient } from "./yogClient.ts";
import { type LogEntry } from "./ui/render/index.ts";
import type { Component } from "./ui/components/Component.ts";
import { ChatViewport } from "./ui/components/ChatViewport.ts";
import { InputComponent } from "./ui/components/InputComponent.ts";
import { StatusComponent } from "./ui/components/StatusComponent.ts";
import { cycleFocus, routeChar, routeKey, type Globals, type Routed } from "./ui/components/keyRouter.ts";
import { createScheduler, runPipeline, writeFrame } from "./ui/pipeline/index.ts";

/** Rows reserved below the log: input bar + status line. */
const STATUS_ROWS = 2;

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

/**
 * Longest well-formed escape sequence at the start of `rest` (CSI `ESC [`
 * or SS3 `ESC O`, parameter bytes up to a final byte); null when the rest
 * starts with plain input or a lone/incomplete escape.
 */
function matchSequence(rest: string): string | null {
  if (!rest.startsWith("\x1b") || rest.length < 2) return null;
  const kind = rest[1];
  if (kind !== "[" && kind !== "O") return null;
  for (let j = 2; j < rest.length; j += 1) {
    const c = rest.charCodeAt(j);
    if (c >= 0x30 && c <= 0x3f) continue; // parameter bytes
    if (c >= 0x40 && c <= 0x7e) return rest.slice(0, j + 1); // final byte
    return null;
  }
  return null; // incomplete at the end of this chunk
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
  const history: HistoryMessage[] = [];
  let quitting = false;

  // ---- render scheduling -------------------------------------------------
  /** Run one frame through the staged render pipeline. */
  const draw = (): void => {
    const cols = process.stdout.columns ?? 80;
    runPipeline({
      width: cols,
      setMetrics: () => {
        const rows = process.stdout.rows ?? 24;
        viewport.setViewportRows(Math.max(1, rows - STATUS_ROWS));
      },
      paint: () => [
        ...viewport.render({ cols }),
        input.render({ cols }),
        status.render({ cols }),
      ],
      emit: writeFrame,
    });
  };

  // Single wiring point: every setState notifies this store subscriber,
  // which coalesces redraws with the FRAME_MS timer and runs the pipeline
  // on flush.
  const scheduler = createScheduler(draw);

  // ---- busy spinner ------------------------------------------------------
  let spinnerTimer: NodeJS.Timeout | undefined;
  const startSpinner = (): void => {
    if (spinnerTimer !== undefined) return;
    setState({ busy: true });
    spinnerTimer = setInterval(() => {
      setState({ busyFrame: getState().busyFrame + 1 });
    }, 90);
  };
  const stopSpinner = (): void => {
    setState({ busy: false });
    if (spinnerTimer !== undefined) {
      clearInterval(spinnerTimer);
      spinnerTimer = undefined;
    }
  };

  // ---- log helpers -------------------------------------------------------
  const pushLines = (kind: LogEntry["kind"], lines: string[]): void => {
    const state = getState();
    state.entries.push({ kind, lines });
    setState({ entries: state.entries });
  };

  // ---- turn submission ---------------------------------------------------
  const submit = (): void => {
    const state = getState();
    const input = state.input.trim();
    if (input === "" || state.busy) return; // one turn at a time (documented)

    const turn = createTurnPresenter(
      {
        entries: state.entries,
        append: pushLines,
        width: () => process.stdout.columns ?? 80,
        requestRender: scheduler.request,
      },
      history,
    );
    turn.begin(input);
    setState({
      input: "",
      cursor: 0,
      inputScroll: 0,
      statusNote: "",
      follow: true,
    });
    startSpinner();

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
        setState({ connection: "error" });
      } finally {
        stopSpinner();
        turn.finish();
        // finish() may have appended to the shared entries array in place.
        setState({ entries: getState().entries });
      }
    })();
  };

  // ---- components --------------------------------------------------------
  const viewport = new ChatViewport();
  const input = new InputComponent();
  const status = new StatusComponent();
  const chain: readonly Component[] = [viewport, input, status];
  const routed: Routed[] = [
    { id: "viewport", component: viewport },
    { id: "input", component: input },
    { id: "status", component: status },
  ];

  /** Rows available to the log viewport in the current terminal layout. */
  const viewportRows = (): number =>
    Math.max(1, (process.stdout.rows ?? 24) - STATUS_ROWS);

  /** Quit: restore the terminal, best-effort session close, then exit. */
  const quit = async (code: number): Promise<void> => {
    if (quitting) return;
    quitting = true;
    scheduler.cancel();
    if (spinnerTimer !== undefined) clearInterval(spinnerTimer);
    restoreTerminal();
    await Promise.race([
      client.close().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    process.exit(code);
  };

  /** Global bindings the router falls back to when no component claims a key. */
  const globals: Globals = {
    quit: () => void quit(0),
    focusNext: () => cycleFocus(routed, 1),
    focusPrev: () => cycleFocus(routed, -1),
    scrollBy: (delta) => viewport.scrollBy(delta, viewportRows()),
    jump: (top) => viewport.jump(top, viewportRows()),
    submit,
  };

  // ---- key handling ------------------------------------------------------
  const handleData = (chunk: string): void => {
    let i = 0;
    while (i < chunk.length) {
      const rest = chunk.slice(i);
      const seq = matchSequence(rest);
      if (seq !== null) {
        routeKey(chain, seq, globals); // unknown sequences are consumed
        i += seq.length;
        continue;
      }
      const cp = rest.codePointAt(0);
      if (cp === undefined) break;
      const ch = String.fromCodePoint(cp);
      routeChar(chain, ch, globals);
      i += ch.length;
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

  // 3. Seed the store with the startup entry and session defaults.
  setState({
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
    model: config.model,
    focusIndex: FOCUS_NONE,
  });

  // 4. Take over the terminal and draw the first frame.
  enterTerminal();
  draw();
}

main();