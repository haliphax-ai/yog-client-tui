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
 *   --session <id>  resume the given server session
 *   --new           start a fresh session (wins over any stored id; the
 *                   new id is written back to state.json)
 *
 * Key bindings (also documented in README). The top-level focus ring has two
 * targets — the input and the log; keys go to whichever side holds the ring:
 *   Shift+Up        input → log
 *   Shift+Down      log → input
 *   Enter           (input) submit, ignored while a turn is in flight
 *                   (log) expand/collapse the focused unit
 *   Shift+Enter     insert a newline in the input (does not submit)
 *   Paste           multi-line text is inserted as-is (never submits)
 *   /new            fresh session: connects to a new server session and
 *                   clears the chat log (current turn must be idle).
 *   /quit           quit via the slash command (type "/" as the first
 *                   character, Tab completes, Enter runs it). Ctrl+C is
 *                   unbound (inert); the session stays on the server so
 *                   the next launch can resume it.
 *   Input editing   the TextArea keymap is fully reachable while the input
 *                   holds the ring (arrows, Alt/Ctrl+arrows word nav,
 *                   Home/End, PgUp/PgDn, Ctrl+A/E/K/U/W, selection, copy).
 *   Log navigation  Home/End jump to top/bottom; PgUp/PgDn scroll by page;
 *                   Up/Down scroll by one row; Tab/Shift-Tab cycle the entry
 *                   focus ring; Esc leaves focus mode (unhandled keys drop).
 *   Esc             (input) abort the in-flight turn via the abort endpoint;
 *                   (log, nothing focused) return to the input.
 */
import { configFilePath, loadConfig, loadState, saveState, stateFilePath } from "./config.ts";
import { type LogEntry } from "./core/entries.ts";
import { FOCUS_NONE_TARGET } from "./core/focus.ts";
import { getState, setState } from "./core/store.ts";
import { finalContextTotal, perTurnDeltas, toTranscriptEntries } from "./core/transcript.ts";
import { createTurnPresenter, transcriptLogEntries } from "./core/turnPresenter.ts";
import { formatTokenTotal } from "./core/toolFormat.ts";
import {
  YogClient,
  YogError,
  type TokenUsage,
  type TurnEvents,
  type TurnOutcome,
} from "./yogClient.ts";
import type { Component } from "./ui/components/Component.ts";
import { ChatViewport } from "./ui/components/ChatViewport.ts";
import { InputComponent } from "./ui/components/InputComponent.ts";
import { StatusComponent } from "./ui/components/StatusComponent.ts";
import { routeChar, routeKey, type Globals } from "./ui/components/keyRouter.ts";
import { emitDebug, isDebugEnabled } from "./ui/debugLog.ts";
import { createInputDecoder } from "./ui/components/inputDecode.ts";
import { appendFileSync } from "node:fs";
import {
  composeMainPane,
  createScheduler,
  resetFrameCache,
  runPipeline,
  writeFrame,
} from "./ui/pipeline/index.ts";
import { isSlash, resolveSlash, slashToken, slashTokenEnd, SLASH_COMMANDS, completeSlash } from "./core/commands.ts";

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
  /** Restored context weight (last known total) when resuming; 0 otherwise. */
  let resumedTokenWeight = 0;
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
      const tokenWeight = finalContextTotal(dump.turns);
      resumedTokenWeight = tokenWeight;
      startupNote(
        `resumed session ${requested} · ${dump.messages.length} messages from server transcript` +
          (tokenWeight > 0 ? ` · ~${formatTokenTotal(tokenWeight)} tokens in context` : ""),
      );
      const cols = process.stdout.columns ?? 80;
      const turnMetrics = perTurnDeltas(dump.turns);
      for (const entry of transcriptLogEntries(toTranscriptEntries(dump.messages), cols, {
        turns: turnMetrics,
      })) {
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
    const rows = process.stdout.rows ?? 24;
    runPipeline({
      width: cols,
      setMetrics: () => {
        // The log gets the remainder after the input bar (which grows by
        // one row when the slash-command autocomplete menu is open) and the
        // status line. The blank line between the log and the input is
        // provided by the composition (the log's own trailing separator at
        // the bottom, or a dedicated margin row when scrolled away).
        viewport.setViewportRows(Math.max(1, rows - input.measure(cols) - status.measure(cols)));
      },
      paint: () =>
        composeMainPane(viewport.render({ cols }), input.render({ cols }), status.render({ cols })),
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
      let command = resolveSlash(prompt);
      // Fuzzy shortcut only applies when the token has no arguments (the
      // token runs to the end of the line). With arguments the user must use
      // Tab completion — we don't want to silently drop their text.
      const tokenEnd = slashTokenEnd(prompt);
      const hasArgs = tokenEnd < prompt.length;
      if (command === undefined && !hasArgs) {
        const matches = completeSlash(prompt);
        if (matches.length > 0) {
          command = resolveSlash(matches[0] as string);
        }
      }
      if (command !== undefined && command.name === "quit") {
        void quit(0);
        return;
      }
      if (command !== undefined && command.name === "new") {
        // Starting a fresh session while a turn is in flight would orphan
        // that turn's events, so require the current turn to finish first.
        if (getState().busy) {
          pushLines("system", ["wait for the current turn, then /new"]);
          input.reset();
          return;
        }
        void (async () => {
          try {
            const id = await client.open();
            // Point the client at the fresh session and clear the log before
            // any next prompt is sent.
            setState({
              entries: [],
              scrollOffset: 0,
              follow: true,
              focusTarget: FOCUS_NONE_TARGET,
              statusNote: "",
              tokenTotals: { prompt: 0, completion: 0, total: 0 },
            });
            await saveState(stateFilePath(), { lastSessionId: id });
            pushLines("system", [`new session ${id} (nothing to resume)`]);
          } catch (err) {
            pushLines("error", [
              `failed to start a new session: ${err instanceof Error ? err.message : String(err)}`,
            ]);
          } finally {
            input.reset();
          }
        })();
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
      prevTokenTotal: () => getState().tokenTotals.total,
    });
    // Surface transcript token totals in the status-bar 🪙 stat: each
    // terminal usage report (finished or aborted at a cut point) carries the
    // latest full-context total, which replaces the stored totals rather than
    // being added on top. Missing fields keep the previous value so a
    // partial report never zeroes a known running total.
    const applyUsageTotal = (usage: TokenUsage): void => {
      const prev = getState().tokenTotals;
      setState({
        tokenTotals: {
          prompt: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : prev.prompt,
          completion:
            typeof usage.completion_tokens === "number" ? usage.completion_tokens : prev.completion,
          total: typeof usage.total_tokens === "number" ? usage.total_tokens : prev.total,
        },
      });
    };
    const baseOnFinish = turn.events.onFinish;
    turn.events.onFinish = (durationMs, stopReason, usage) => {
      baseOnFinish?.(durationMs, stopReason, usage);
      if (usage !== undefined) applyUsageTotal(usage);
    };
    const baseOnAborted = turn.events.onAborted;
    turn.events.onAborted = (reason, usage) => {
      baseOnAborted?.(reason, usage);
      if (usage !== undefined) applyUsageTotal(usage);
    };
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
  // Top-level focus ring: the log and the input are the two ring targets.
  viewport.ring = "log";
  input.ring = "input";
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
  /** Optional key-debug log file (`YOG_DEBUG_KEYS=<file>`, default /tmp). */
  const keyEnv = process.env.YOG_DEBUG_KEYS;
  const keyDebugPath =
    keyEnv === undefined || keyEnv === ""
      ? undefined
      : keyEnv === "1"
        ? "/tmp/yog-client-keys.log"
        : keyEnv;
  /** Raw-input decoder (sequences, chars, bracketed paste framing). */
  const decodeInput = createInputDecoder({
    onSequence: (seq) => {
      emitDebug([`key ${Buffer.from(seq, "utf8").toString("hex")}`]);
      routeKey(chain, seq, globals);
    },
    onChar: (ch) => {
      emitDebug([`char ${Buffer.from(ch, "utf8").toString("hex")}`]);
      routeChar(chain, ch, globals);
    },
    onPasteEnd: (content) => {
      emitDebug([`paste ${Buffer.byteLength(content, "utf8")} bytes`]);
      input.paste(content);
    },
  });

  const handleData = (chunk: string): void => {
    if (keyDebugPath !== undefined) {
      appendFileSync(keyDebugPath, `${Buffer.from(chunk, "utf8").toString("hex")}\n`);
    }
    decodeInput(chunk);
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
    // Seed the status-bar total with the restored context so the first live
    // turn after a resume shows only its own incremental tokens.
    tokenTotals: { prompt: 0, completion: 0, total: resumedTokenWeight },
  });

  // Client-side debug chunks are seeded when enabled so the mode is visible.
  if (isDebugEnabled()) emitDebug(["client-side debug log enabled"]);

  // 4. Take over the terminal and draw the first frame.
  enterTerminal();
  draw();
}

main();
