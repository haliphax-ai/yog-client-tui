/**
 * Entry point / wiring only: terminal lifecycle, key handling, render
 * scheduling, and the config → yogClient → presenter → view pipeline.
 * UI state lives in the central store (`core/store`); the render scheduler
 * subscribes to it once, coalesces bursts into one flush, and the flush runs
 * the staged render pipeline (`ui/pipeline`: layout → paint → compose → post
 * → emit). Mutations go through `setState`, which notifies subscribers.
 *
 * The server owns the canonical transcript: turns send only the new prompt,
 * and startup resumes (or creates) a session and rehydrates the visible
 * conversation from the server transcript before the first frame is drawn.
 * Quitting never deletes the session — the next launch picks up where this
 * one left off (a hard end is a future server-side purge command, not the
 * quit path).
 *
 * Key handling is focus-scoped: `keyRouter` offers each key to the focused
 * component first, then the remaining components, then the globals below.
 * The viewport, input bar, and status line are components (`ui/components`);
 * the pipeline's paint stage renders their rows and emit writes the frame.
 *
 * CLI flags:
 *   --session <id>   resume the given server session
 *   --new            start a fresh session (wins over any stored id; the
 *                    new id is written back to state.json)
 *
 * Key bindings (also documented in README):
 *   Enter            submit (ignored while a turn is in flight)
 *   Shift+Enter     insert a newline in the input (does not submit)
 *   Paste           multi-line text is inserted as-is (never submits)
 *   /quit           quit via the slash command (type "/" as the first
 *                    character, Tab completes, Enter runs it). Ctrl+C is
 *                    unbound (inert); the session stays on the server so
 *                    the next launch can resume it.
 *   Left/Right       move the input cursor
 *   Home/End         input cursor to line start/end
 *   Backspace/Delete delete before/at cursor
 *   PageUp/PageDown  scroll the log (stops auto-follow; PageDown at the
 *                    bottom resumes it)
 *   Ctrl+Home/Ctrl+End  jump to top/bottom of the log (End resumes follow)
 *   Up/Down          scroll the log by one row (when the input is
 *                    single-line; multi-line input moves the caret instead)
 *   Tab / Shift-Tab focus the next/previous expandable entry (tool chunk,
 *                    table-bearing message) — Enter expands/collapses it,
 *                    Esc leaves focus mode (focus wraps through "none")
 *   Left/Right (on a focused expanded table)  scroll columns horizontally
 *   Esc              abort the in-flight turn via the server's abort endpoint
 *                    (no-op when idle; with a focused entry it still just
 *                    leaves focus mode)
 */
import { configFilePath, loadConfig, loadState, saveState, stateFilePath } from "./config.ts";
import { type LogEntry } from "./core/entries.ts";
import { FOCUS_NONE_TARGET } from "./core/focus.ts";
import { getState, setState } from "./core/store.ts";
import { toTranscriptEntries } from "./core/transcript.ts";
import { createTurnPresenter, transcriptLogEntries } from "./core/turnPresenter.ts";
import { YogClient, YogError, type TurnEvents, type TurnOutcome } from "./yogClient.ts";
import type { Component } from "./ui/components/Component.ts";
import { ChatViewport } from "./ui/components/ChatViewport.ts";
import { InputComponent } from "./ui/components/InputComponent.ts";
import { StatusComponent } from "./ui/components/StatusComponent.ts";
import { routeChar, routeKey, type Globals } from "./ui/components/keyRouter.ts";
import { emitDebug, isDebugEnabled } from "./ui/debugLog.ts";
import { createScheduler, resetFrameCache, runPipeline, writeFrame } from "./ui/pipeline/index.ts";
import { isSlash, resolveSlash, slashToken, SLASH_COMMANDS } from "./core/commands.ts";

/** Terminal state shared with error paths (module scope, always in sync). */
let terminalActive = false;

/** Restore the terminal: leave the alternate screen, re-enable the cursor. */
function restoreTerminal(): void {
  if (!terminalActive) return;
  terminalActive = false;
  process.stdout.write("\x1b[?1049l\x1b[?25h\x1b[?2004l");
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

/** Parsed command-line flags: `--session <id>` resume id, `--new` fresh start. */
interface CliFlags {
  session?: string;
  new: boolean;
}

/**
 * Minimal flag scan (PLAN §5.5 item 1): `--session <id>` and `--new`;
 * anything else (positional arguments included) is an error. `--new` wins
 * over any session id — "start fresh" is the more specific intent.
 */
export function parseFlags(argv: readonly string[]): CliFlags {
  const flags: CliFlags = { new: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--new") {
      flags.new = true;
      continue;
    }
    if (arg === "--session") {
      const value = argv[i + 1];
      if (value === undefined || value === "") {
        throw new Error("--session requires a session id argument");
      }
      flags.session = value;
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg} (supported: --session <id>, --new)`);
  }
  return flags;
}

function main(): void {
  // Non-TTY safety: fail fast with a clear message instead of crashing.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      "yog-client-tui requires an interactive terminal (stdin/stdout is not a TTY).\n",
    );
    process.exit(1);
  }

  void run(process.argv.slice(2)).catch((err: unknown) => {
    restoreTerminal();
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

async function run(argv: readonly string[]): Promise<void> {
  const flags = parseFlags(argv);

  // 1. Config.
  const config = await loadConfig(configFilePath());
  const baseUrl = config.baseUrl;
  const state = await loadState(stateFilePath());
  const requested = flags.new ? undefined : (flags.session ?? state.lastSessionId ?? undefined);

  // ---- log helpers (needed by startup seeding and turns alike) -----------
  const pushLines = (kind: LogEntry["kind"], lines: string[]): void => {
    const state = getState();
    state.entries.push({ kind, lines });
    setState({ entries: state.entries });
  };

  // 2. Capabilities probe + session resolution + transcript rehydration —
  //    all before the screen is taken over, so startup failures print
  //    plainly and exit non-zero.
  const client = new YogClient(baseUrl);
  const caps = await client.probe();
  if (!caps.features.includes("transcript")) {
    throw new Error("server does not advertise the transcript feature; run the current yog");
  }

  /** Startup notes and rehydrated conversation, seeded before the first frame. */
  const seedEntries: LogEntry[] = [];
  const startupNote = (line: string): void => {
    seedEntries.push({ kind: "system", lines: [line] });
  };

  /**
   * Resume-or-create (PLAN §5.5 item 1): `--new` short-circuits everything
   * and forces a fresh session; then an explicit `--session <id>`; then the
   * stored `lastSessionId` from state.json; otherwise create. A resumable id
   * is validated with `reopen` and hydrated from the server transcript (full
   * dump, no pagination); a stale id (`unknown_session`) falls back to a fresh
   * session with a one-line note. Transport failures propagate — only a
   * stale id is recoverable.
   */
  const resolveSession = async (): Promise<void> => {
    if (requested === undefined) {
      const id = await client.open();
      startupNote(`new session ${id} (nothing to resume)`);
      return;
    }
    try {
      const adopted = await client.reopen(requested);
      if (adopted === undefined) {
        throw new YogError("unknown_session", `session ${requested} not found`, 404);
      }
      const dump = await client.getTranscript();
      startupNote(
        `resumed session ${requested} · ${dump.messages.length} messages from server transcript`,
      );
      const cols = process.stdout.columns ?? 80;
      for (const entry of transcriptLogEntries(toTranscriptEntries(dump.messages), cols)) {
        seedEntries.push(entry);
      }
      return;
    } catch (err) {
      if (!(err instanceof YogError) || err.code !== "unknown_session") throw err;
      // Stale id only: fall through to a fresh session below.
    }
    startupNote(`session ${requested} is gone — started fresh`);
    const id = await client.open();
    startupNote(`new session ${id} (nothing to resume)`);
  };

  await resolveSession();
  // Persist the resolved id so the next launch resumes automatically. A
  // startup failure above never reaches this write, so a stored id survives.
  await saveState(stateFilePath(), { lastSessionId: client.sessionId ?? null });

  // ---- state -------------------------------------------------------------
  let quitting = false;

  // ---- render scheduling -------------------------------------------------
  /** Run one frame through the staged render pipeline. */
  const draw = (): void => {
    const cols = process.stdout.columns ?? 80;
    runPipeline({
      width: cols,
      setMetrics: () => {
        const rows = process.stdout.rows ?? 24;
        const cols = process.stdout.columns ?? 80;
        // The log gets the remainder after the input bar (which grows by
        // one row when the slash-command autocomplete menu is open) and the
        // status line.
        viewport.setViewportRows(Math.max(1, rows - input.measure(cols) - status.measure(cols)));
      },
      paint: () => [...viewport.render({ cols }), input.render({ cols }), status.render({ cols })],
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

  // ---- turn submission ---------------------------------------------------
  /**
   * Run one turn, sending only the new prompt (the server hydrates prior
   * context from its canonical transcript). A stale session id — the server
   * purged or pruned it — restarts with a fresh session, notes the fallback,
   * and replays the turn once against the new id.
   */
  const turnWithRecovery = async (prompt: string, events: TurnEvents): Promise<TurnOutcome> => {
    try {
      return await client.runTurn(prompt, config.model, events);
    } catch (err) {
      if (!(err instanceof YogError) || err.code !== "unknown_session") throw err;
      const staleId = client.sessionId;
      const freshId = await client.open();
      pushLines("system", [`session ${staleId} is gone — started fresh`]);
      pushLines("system", [`new session ${freshId} (nothing to resume)`]);
      await saveState(stateFilePath(), { lastSessionId: freshId });
      return await client.runTurn(prompt, config.model, events);
    }
  };

  /**
   * Submit the input line. A line beginning with "/" is a slash command:
   * resolved against the registry and run instead of being sent as a prompt.
   * Commands bypass the busy gate (e.g. /quit must work mid-turn). Plain
   * prompts are ignored while a turn is in flight (one turn at a time).
   */
  const submit = (): void => {
    const state = getState();
    const prompt = state.input.trim();
    if (prompt === "") return;

    // Slash command path (works even while a turn is in flight).
    if (isSlash(prompt)) {
      const command = resolveSlash(prompt);
      if (command !== undefined && command.name === "quit") {
        void quit(0);
        return;
      }
      const token = slashToken(prompt) ?? "";
      const available = SLASH_COMMANDS.map((c) => "/" + c.name).join(", ");
      pushLines("system", [`unknown command: /${token} — available: ${available}`]);
      input.reset();
      return;
    }

    if (state.busy) return; // one turn at a time (documented)

    const turn = createTurnPresenter({
      entries: state.entries,
      append: pushLines,
      width: () => process.stdout.columns ?? 80,
      requestRender: scheduler.request,
    });
    turn.begin(prompt);
    input.reset();
    setState({ statusNote: "", follow: true });
    startSpinner();

    void (async () => {
      try {
        const outcome = await turnWithRecovery(prompt, turn.events);
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
        // The turn's events may have appended to the shared entries array
        // in place.
        setState({ entries: getState().entries });
      }
    })();
  };

  /**
   * Abort the in-flight turn (Esc with no focused entry): POST the abort
   * endpoint. The turn's SSE stream frames the terminal `turn.aborted`
   * event, which settles `runTurn` and stops the spinner through the normal
   * completion path — the abort call itself only fires the request. A
   * transport failure here is logged; the turn keeps running either way.
   */
  const abortActiveTurn = (): void => {
    if (!getState().busy || client.sessionId === undefined) return;
    void client.abortTurn().catch((err: unknown) => {
      pushLines("system", [`abort failed: ${err instanceof Error ? err.message : String(err)}`]);
    });
  };

  // ---- components --------------------------------------------------------
  const viewport = new ChatViewport();
  const input = new InputComponent();
  const status = new StatusComponent();
  const chain: readonly Component[] = [viewport, input, status];

  /** Rows available to the log viewport in the current terminal layout. */
  const viewportRows = (): number =>
    Math.max(
      1,
      (process.stdout.rows ?? 24) -
        input.measure(process.stdout.columns ?? 80) -
        status.measure(process.stdout.columns ?? 80),
    );

  /**
   * Quit: restore the terminal and exit. The session is NOT deleted — the
   * server owns it and keeps the transcript, so the next launch resumes
   * where this one left off (the DELETE endpoint is a detach, and a hard
   * end is a future server-side purge command, not the quit path).
   */
  const quit = async (code: number): Promise<void> => {
    if (quitting) return;
    quitting = true;
    setState({ statusNote: "session saved — bye" });
    scheduler.cancel(); // flush the note through the pipeline before exiting
    if (spinnerTimer !== undefined) clearInterval(spinnerTimer);
    restoreTerminal();
    process.exit(code);
  };

  /** Global bindings the router falls back to when no component claims a key. */
  const globals: Globals = {
    quit: () => void quit(0),
    focusNext: () => viewport.cycleFocus(1),
    focusPrev: () => viewport.cycleFocus(-1),
    scrollBy: (delta) => viewport.scrollBy(delta, viewportRows()),
    jump: (top) => viewport.jump(top, viewportRows()),
    submit,
    abortTurn: abortActiveTurn,
    pageRows: () => process.stdout.rows ?? 24,
  };

  // ---- key handling ------------------------------------------------------
  /** Bracketed-paste framing: content between `200~`/`201~` is buffered. */
  let pasting = false;
  let pasteBuffer = "";
  /** Client-side debug log: hex of a raw input chunk/char. */
  const toHex = (s: string): string => Buffer.from(s, "utf8").toString("hex");

  const handleData = (chunk: string): void => {
    let i = 0;
    while (i < chunk.length) {
      const rest = chunk.slice(i);
      const seq = matchSequence(rest);
      if (seq !== null) {
        if (pasting) {
          if (seq === "\x1b[201~") {
            // End of bracketed paste — deliver the whole buffer to the input
            // as one insertion (newlines included, never submitted).
            pasting = false;
            const content = pasteBuffer;
            pasteBuffer = "";
            input.paste(content);
            emitDebug([`paste ${Buffer.byteLength(content, "utf8")} bytes`]);
          } else {
            pasteBuffer += seq;
          }
          i += seq.length;
          continue;
        }
        if (seq === "\x1b[200~") {
          pasting = true;
          pasteBuffer = "";
          i += seq.length;
          continue;
        }
        emitDebug([`key ${toHex(seq)}`]);
        routeKey(chain, seq, globals); // unknown sequences are consumed
        i += seq.length;
        continue;
      }
      const cp = rest.codePointAt(0);
      if (cp === undefined) break;
      const ch = String.fromCodePoint(cp);
      if (pasting) {
        pasteBuffer += ch;
        i += ch.length;
        continue;
      }
      emitDebug([`char ${toHex(ch)}`]);
      routeChar(chain, ch, globals);
      i += ch.length;
    }
  };

  // ---- terminal lifecycle ------------------------------------------------
  const enterTerminal = (): void => {
    terminalActive = true;
    process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[2J\x1b[H");
    process.stdin.setEncoding("utf8");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", handleData);

    const onResize = (): void => {
      // The emit stage diffs rows against the previous frame — a cleared
      // screen invalidates that baseline, so the next write repaints all.
      resetFrameCache();
      process.stdout.write("\x1b[2J\x1b[H");
      draw();
    };
    process.stdout.on("resize", onResize);
    process.on("SIGWINCH", onResize);
    process.on("SIGTERM", () => void quit(0));
  };

  // 3. Seed the store: startup banner, then the rehydrated transcript and
  //    startup notes (new/resumed/stale-id) already gathered above.
  setState({
    entries: [
      {
        kind: "system",
        lines: [
          `connected to ${baseUrl} · contract ${caps.contractVersion} · ` +
            `${caps.models.length} model(s) · ${caps.tools.length} tool(s)`,
          `model ${config.model} · /quit exits`,
        ],
      },
      ...seedEntries,
    ],
    model: config.model,
    focusTarget: FOCUS_NONE_TARGET,
  });

  // Client-side debug chunks are seeded when enabled so the mode is visible.
  if (isDebugEnabled()) emitDebug(["client-side debug log enabled"]);

  // 4. Take over the terminal and draw the first frame.
  enterTerminal();
  draw();
}

main();
