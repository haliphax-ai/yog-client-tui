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
 *                   unbound (inert); the session stays on the server and
 *                   an in-flight turn keeps running there (wire-independent
 *                   turn), so the next launch resumes it and rehydrates the
 *                   turn's result.
 *   Input editing   the TextArea keymap is fully reachable while the input
 *                   holds the ring (arrows, Alt/Ctrl+arrows word nav,
              // compact and handoff both start a fresh server session — adopt it
              // so a restart resumes the new session, not the archived one.
              if (typeof result.sessionId === "string") {
                client.sessionId = result.sessionId;
                await saveState(stateFilePath(), { lastSessionId: result.sessionId });
              }
 *                   (log, nothing focused) return to the input.
 */
import { configFilePath, loadConfig, loadState, saveState, stateFilePath } from "./config.ts";
import { type LogEntry } from "./core/entries.ts";
import { FOCUS_NONE_TARGET } from "./core/focus.ts";
import { addLiveCompletionTokens, getState, setState } from "./core/store.ts";
import {
  estimatedContextTotal,
  finalContextTotal,
  perTurnDeltas,
  toTranscriptEntries,
} from "./core/transcript.ts";
import {
  createTurnPresenter,
  placeholderLogEntries,
  rehydrateGroupIndices,
  rehydrateGroups,
  transcriptLogEntries,
} from "./core/turnPresenter.ts";
import { noticeLine } from "./core/notices.ts";
import { formatTokenTotal } from "./core/toolFormat.ts";
import {
  YogClient,
  YogError,
  type TokenUsage,
  type TranscriptResult,
  type TurnEvents,
  type TurnOutcome,
} from "./yogClient.ts";
import type { Component } from "./ui/components/Component.ts";
import { ChatViewport } from "./ui/components/ChatViewport.ts";
import { InputComponent } from "./ui/components/InputComponent.ts";
import { StatusComponent } from "./ui/components/StatusComponent.ts";
import { DrawerComponent } from "./ui/components/DrawerComponent.ts";
import { GeneratingComponent } from "./ui/components/GeneratingComponent.ts";
import { registerDrawerChild } from "./ui/components/drawerRegistry.ts";
import {
  composeMainPane,
  createScheduler,
  resetFrameCache,
  runPipeline,
  writeFrame,
} from "./ui/pipeline/index.ts";
import {
  isSlash,
  resolveSlash,
  slashToken,
  slashTokenEnd,
  SLASH_COMMANDS,
  completeSlash,
} from "./core/commands.ts";
import { getTopLevel, routeChar, routeKey, type Globals } from "./ui/components/keyRouter.ts";
import { splitTableSections } from "./ui/render/table/index.ts";
import { createInputDecoder } from "./ui/components/inputDecode.ts";
import {
  emitDebug,
  isDebugEnabled,
  isKeyLogEnabled,
  keyLogPath,
  setKeyDumpSink,
} from "./ui/debugLog.ts";
import {
  type CopyRequest,
  tableCopyRequest,
  toolCopyRequest,
  proseCopyRequest,
} from "./core/copyText.ts";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ToastComponent } from "./ui/components/ToastComponent.ts";
import { runWlCopy } from "./ui/clipboard.ts";

/**
 * Last-resort crash handler: an error escaping an async callback (a scheduler
 * flush, an SSE event, a spinner tick) never reaches `main`'s catch — it would
 * otherwise tear the process down mid-session with the terminal in raw mode.
 * Surface it through the notice system (the exception message on an ❌ error
 * line), stash the full stack in a 🐞 debug chunk when YOG_DEBUG=1, restore
 * the terminal, and exit non-zero. Synchronous startup failures keep the
 * plain-stderr path in `main()` — the chat log does not exist yet. `scheduler`
 * lives inside `run()`, so this file-level function reaches it through a
 * module-scope holder assigned once the scheduler is created.
 */
/** Module-scope handle to the render scheduler (set once `run()` wires it). */
let fatalScheduler: (() => void) | undefined;

function handleFatal(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (terminalActive) {
    if (isDebugEnabled() && err instanceof Error && err.stack !== undefined) {
      emitDebug(["fatal error stack:", ...err.stack.split("\n")]);
    }
    // pushLines-shaped: same one-line ❌ shape every other producer uses.
    const state = getState();
    state.entries.push({ kind: "error", lines: noticeLine("error", "fatal error", message) });
    setState({ entries: state.entries });
    fatalScheduler?.(); // let the flush draw the notice before exiting
  }
  restoreTerminal();
  process.stderr.write(`fatal: ${message}\n`);
  process.exit(1);
}

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

  // Last-resort handlers for errors that escape an async callback (a render
  // flush, an SSE event, a spinner tick) — main()'s await-catch only covers
  // startup. Handle them identically: notice + debug stack + clean terminal.
  process.on("uncaughtException", handleFatal);
  process.on("unhandledRejection", (reason) => handleFatal(reason));
  void run(process.argv.slice(2)).catch(handleFatal);
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
  /** The next transcript message seq: the server numbers messages
   *  monotonically per session, so the user prompt the next turn appends
   *  will carry this seq as its item id (one past the current tail). */
  const nextMessageSeq = (): string => {
    const entries = getState().entries;
    // Rehydrated rows stamp `String(message.seq)`; the live tail is the
    // highest id seen so far. Non-numeric ids (tool-call ids on rehydrated
    // tool rows) are skipped, not counted.
    let maxSeq = 0;
    for (const entry of entries) {
      const id = entry.copyIds?.itemId;
      const n = id === undefined ? Number.NaN : Number(id);
      if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
    }
    return String(maxSeq + 1);
  };

  // 2. Capabilities probe + session resolution + transcript rehydration —
  //    all before the screen is taken over, so startup failures print
  //    plainly and exit non-zero.
  const client = new YogClient(baseUrl);
  const caps = await client.probe(config.model);
  // Extract context window size for the configured model from capabilities
  const contextWindow = caps.contextWindowSizes?.[config.model];
  if (!caps.features.includes("transcript")) {
    throw new Error("server does not advertise the transcript feature; run the current yog");
  }

  /** Startup notes and rehydrated conversation, seeded before the first frame. */
  const seedEntries: LogEntry[] = [];
  /** Startup notes only (no transcript rows): a poll rehydration rebuilds
   * the transcript from its fresh dump, so composing notes + fresh rows
   * must not also include the resume-time transcript rows in seedEntries. */
  const startupNotes: LogEntry[] = [];
  const startupNote = (event: string, detail?: string): void => {
    const entry: LogEntry = { kind: "notice", lines: noticeLine("notice", event, detail) };
    seedEntries.push(entry);
    startupNotes.push(entry);
  };

  /* Startup banner entries, kept separate so a poll's rehydration can
   * keep them ahead of the transcript without duplicating them. */
  const bannerEntries = (): LogEntry[] => [
    {
      kind: "notice",
      lines: noticeLine(
        "notice",
        "connected",
        `${baseUrl} · contract ${caps.contractVersion} · ` +
          `${caps.models.length} model(s) · ${caps.tools.length} tool(s)`,
      ),
    },
    {
      kind: "notice",
      lines: noticeLine("notice", "model", `${config.model} · /quit exits`),
    },
  ];

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
  /** The resume-time transcript dump (for reconnect turn pickup). */
  let resumeDump: TranscriptResult | undefined;
  /**
   * Pending bottom-up rehydration job (#67): placeholders are already in
   * `seedEntries`; `driveRehydrate` (after the first frame) swaps each
   * group for its real entries, last group first.
   */
  let pendingRehydrate:
    | {
        transcriptEntries: ReturnType<typeof toTranscriptEntries>;
        groups: LogEntry[][];
        indices: number[][];
        logPos: number[];
      }
    | undefined;
  const resolveSession = async (): Promise<void> => {
    if (requested === undefined) {
      const id = await client.open();
      startupNote("new session", id);
      return;
    }
    try {
      const adopted = await client.reopen(requested);
      if (adopted === undefined) {
        throw new YogError("unknown_session", `session ${requested} not found`, 404);
      }
      const dump = await client.getTranscript();
      resumeDump = dump;
      let tokenWeight = finalContextTotal(dump.turns);
      if (tokenWeight <= 0) tokenWeight = estimatedContextTotal(dump.messages);
      resumedTokenWeight = tokenWeight;
      startupNote(
        "session resumed",
        `${requested} · ${dump.messages.length} messages from server transcript` +
          (tokenWeight > 0 ? ` · ~${formatTokenTotal(tokenWeight)} tokens in context` : ""),
      );
      const cols = process.stdout.columns ?? 80;
      const turnMetrics = perTurnDeltas(dump.turns);
      // Placeholder-first rehydrate (#67): every transcript row gets a
      // cheap placeholder *now* (O(1) per row, no glamour), so the first
      // frame paints instantly. Real entries swap in bottom-up (last
      // chunk first — the part the user sees) via `driveRehydrate`
      // after the terminal is taken over.
      const transcriptEntries = toTranscriptEntries(dump.messages);
      const placeholderStart = seedEntries.length;
      for (const entry of placeholderLogEntries(transcriptEntries, cols)) {
        seedEntries.push(entry);
      }
      pendingRehydrate = {
        transcriptEntries,
        groups: rehydrateGroups(transcriptEntries, cols, { turns: turnMetrics }),
        indices: rehydrateGroupIndices(transcriptEntries),
        // Log position of each transcript row's placeholder at seed time.
        logPos: transcriptEntries.map((_, i) => bannerEntries().length + placeholderStart + i),
      };
      return;
    } catch (err) {
      if (!(err instanceof YogError) || err.code !== "unknown_session") throw err;
      // Stale id only: fall through to a fresh session below.
    }
    startupNote("session reset", `${requested} is gone — started fresh`);
    const id = await client.open();
    startupNote("new session", id);
  };

  // ---- busy spinner ------------------------------------------------------
  // The generating notification is a self-contained producer component
  // (Bubbles spinner model, own tick timer) registered into the drawer; the
  // drawer itself stays a generic container. The composition root flips the
  // store's `busy` flag and the component's timer together.
  const generating = new GeneratingComponent();
  registerDrawerChild(generating);
  const startSpinner = (): void => {
    setState({ busy: true });
    generating.start();
  };
  const stopSpinner = (): void => {
    setState({ busy: false });
    generating.stop();
  };

  await resolveSession();
  // Reconnect pickup (yog#88 / yog#31): `running` turn at resume —
  // spinner on, a startup note, and a poll that replays each fresh
  // transcript dump through the same path resolveSession uses, so
  // completed rows appear before the turn settles.
  // Pick the LAST running row: the server's orchestrator-owned row is
  // the one stamped with events/messages/usage (any earlier adapter row
  // is a duplicate with none of those), and `.find` (first) would wait
  // on the wrong row forever.
  const runningTurn = [...(resumeDump?.turns ?? [])].reverse().find((t) => t.status === "running");
  const pollRunningTurn = (turnId: number): void => {
    startSpinner();
    let lastSignature = "";
    const timer: NodeJS.Timeout = setInterval(() => {
      void (async () => {
        try {
          const fresh = await client.getTranscript();
          const row = (fresh.turns ?? []).find((t) => t.turnId === turnId);
          if (row === undefined) return;
          const settled = row.status !== undefined && row.status !== "running";
          const cols = process.stdout.columns ?? 80;
          const entries = transcriptLogEntries(toTranscriptEntries(fresh.messages), cols, {
            turns: perTurnDeltas(fresh.turns),
          });
          let total = finalContextTotal(fresh.turns);
          if (total <= 0) total = row.usage?.total_tokens ?? 0;
          if (total <= 0) total = estimatedContextTotal(fresh.messages);
          // Update whenever the visible content changes — not only when
          // the token total climbs. The old gates (`usage.total_tokens`
          // must be present, total must exceed the last total) meant a
          // running turn with no reported usage yet, or with usage that
          // only moves at round boundaries, never landed in the log
          // while generating, and the settled turn could be dropped by
          // the total gate as well. Signature on message count + last
          // seq + settled flag + total: any of those moving is visible.
          const lastMessage = fresh.messages[fresh.messages.length - 1];
          const signature = [
            fresh.messages.length,
            lastMessage?.seq ?? 0,
            settled ? row.status : "running",
            total,
          ].join(":");
          if (!settled && signature === lastSignature) return;
          lastSignature = signature;
          setState({
            entries: [...bannerEntries(), ...startupNotes, ...entries],
            tokenTotals: { prompt: 0, completion: 0, total },
          });
          if (settled) {
            clearInterval(timer);
            stopSpinner();
          }
        } catch {
          // Polling is best effort: a failed probe keeps the previous state
          // and retries on the next tick.
        }
      })();
    }, 2000);
  };
  if (runningTurn !== undefined) {
    startupNote("turn in flight", "this session has a running turn — generating");
    pollRunningTurn(runningTurn.turnId);
  }
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
        // one row when the slash-command autocomplete menu is open), the
        // drawer (zero rows when fully collapsed), and the status line —
        // plus the row the composition consumes for the log gap when the
        // drawer is visible (its top padding is that gap).
        viewport.setViewportRows(
          Math.max(
            1,
            rows -
              input.measure(cols) -
              drawer.measure(cols) -
              status.measure(cols) +
              drawerGap(cols),
          ),
        );
      },
      paint: () =>
        composeMainPane(
          viewport.render({ cols }),
          drawer.render({ cols }),
          input.render({ cols }),
          status.render({ cols }),
        ),
      emit: writeFrame,
    });
  };

  // Single wiring point: every setState notifies this store subscriber,
  // which coalesces redraws with the FRAME_MS timer and runs the pipeline
  // on flush.
  const scheduler = createScheduler(draw);
  // The fatal handler draws its notice through the same flush timer.
  fatalScheduler = scheduler.request;

  // ---- bottom-up rehydration driver (#67) ---------------------------------
  /**
   * Swap real entries in for placeholders, last transcript group first
   * (bottom-up — the part the user actually sees materializes first).
   * Each tick swaps a small batch, then `setState` coalesces one frame;
   * far-head groups glamour later, never before the visible region.
   * Runs to completion even if the user starts typing — swaps only
   * replace placeholder positions, never user-appended live entries
   * (live entries append after the rehydrated span, tracked via a
   * generation check: if the log no longer holds our placeholders at
   * the expected positions, the job aborts silently).
   */
  const driveRehydrate = (): void => {
    if (pendingRehydrate === undefined) return;
    const job = pendingRehydrate;
    const { groups, indices, logPos } = job;
    // Operate on the live log: re-read it each tick so a concurrent
    // poll replacement (running-turn pickup) wins and aborts the job
    // via the generation check, instead of being clobbered by a stale
    // snapshot.
    let log = getState().entries;
    let nextGroup = groups.length - 1;
    let cancelled = false;
    const step = (): void => {
      log = getState().entries;
      if (log.length < logPos.length && nextGroup >= 0) {
        // Log shrank (e.g. /new cleared it) — abort the job.
        cancelled = true;
        pendingRehydrate = undefined;
        return;
      }
      if (cancelled || nextGroup < 0) {
        pendingRehydrate = undefined;
        return;
      }
      const started = performance.now();
      let swapped = 0;
      while (nextGroup >= 0 && swapped < 6) {
        const group = groups[nextGroup] as LogEntry[];
        const covered = indices[nextGroup] as number[];
        const firstPos = logPos[covered[0] as number] as number;
        // Generation check: the placeholder must still be there.
        if (log[firstPos]?.kind !== "placeholder") {
          cancelled = true;
          pendingRehydrate = undefined;
          return;
        }
        // Replace the covered placeholders (contiguous) with the group.
        log.splice(firstPos, covered.length, ...group);
        const delta = group.length - covered.length;
        if (delta !== 0) {
          for (let k = 0; k < logPos.length; k++) {
            if ((logPos[k] as number) > (firstPos as number))
              logPos[k] = (logPos[k] as number) + delta;
          }
        }
        nextGroup -= 1;
        swapped += 1;
        if (performance.now() - started > 8) break;
      }
      setState({ entries: log });
      if (nextGroup >= 0) {
        setTimeout(step, 0);
      } else {
        pendingRehydrate = undefined;
      }
    };
    // First tick after the placeholder frame has painted.
    setTimeout(step, 0);
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
      pushLines(
        "notice",
        noticeLine("notice", "session reset", `id ${staleId} is gone — started fresh`),
      );
      pushLines("notice", noticeLine("notice", "new session", freshId));
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
          pushLines(
            "notice",
            noticeLine("notice", "warning", "wait for the current turn, then /new"),
          );
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
              tokenTotals: { prompt: 0, completion: 0, total: 0 },
            });
            await saveState(stateFilePath(), { lastSessionId: id });
            pushLines("notice", noticeLine("notice", "new session", id));
          } catch (err) {
            pushLines(
              "error",
              noticeLine(
                "error",
                "new session failed",
                err instanceof Error ? err.message : String(err),
              ),
            );
          } finally {
            input.reset();
          }
        })();
        return;
      }
      if (
        command !== undefined &&
        (command.name === "compact" || command.name === "handoff" || command.name === "shake")
      ) {
        if (getState().busy) {
          pushLines(
            "notice",
            noticeLine("notice", "warning", `wait for the current turn, then /${command.name}`),
          );
          input.reset();
          return;
        }
        const kind = command.name;
        if (!(client.capabilities?.features ?? []).includes(kind)) {
          pushLines(
            "error",
            noticeLine("error", "unsupported command", `/${kind} is not enabled on this server`),
          );
          input.reset();
          return;
        }
        const guidance = prompt.slice(slashTokenEnd(prompt)).trim();
        input.reset(); // clear immediately on submit, before the command starts
        void (async () => {
          startSpinner();
          try {
            if (kind === "shake") {
              const outcome = await client.shake();
              const weight = outcome.contextSize;
              setState({
                tokenTotals: { prompt: 0, completion: 0, total: weight },
              });
              pushLines(
                "notice",
                noticeLine(
                  "notice",
                  "shake",
                  `${outcome.argsTruncated} arg(s), ` +
                    `${outcome.resultsTruncated} result(s) truncated; ` +
                    `totals reset to ~${formatTokenTotal(weight)}`,
                ),
              );
            } else {
              const result =
                kind === "compact"
                  ? await client.compact(guidance || undefined)
                  : await client.handoff(guidance || undefined);
              // compact and handoff both start a fresh server session — adopt it
              // so a restart resumes the new session, not the archived one.
              if (typeof result.sessionId === "string") {
                client.sessionId = result.sessionId;
                await saveState(stateFilePath(), { lastSessionId: result.sessionId });
              }
              const dump = await client.getTranscript();
              const cols = process.stdout.columns ?? 80;
              const entries = transcriptLogEntries(toTranscriptEntries(dump.messages), cols, {
                turns: perTurnDeltas(dump.turns),
              });
              setState({
                entries,
                tokenTotals: {
                  prompt: 0,
                  completion: 0,
                  total: estimatedContextTotal(dump.messages),
                },
              });
              const truncatedNote = result.truncated ? " (input was middle-truncated)" : "";
              pushLines(
                "notice",
                noticeLine(
                  "notice",
                  kind,
                  `fresh transcript started (model ${result.model}, ` +
                    `summary ${result.summary.length} chars${truncatedNote})`,
                ),
              );
            }
          } catch (err) {
            pushLines(
              "error",
              noticeLine(
                "error",
                `${kind} failed`,
                err instanceof Error ? err.message : String(err),
              ),
            );
          } finally {
            stopSpinner();
          }
        })();
        return;
      }

      const token = slashToken(prompt) ?? "";
      const available = SLASH_COMMANDS.map((c) => "/" + c.name).join(", ");
      pushLines(
        "error",
        noticeLine("error", "unknown command", `/${token} — available: ${available}`),
      );
      input.reset();
      return;
    }

    if (state.busy) return; // one turn at a time (documented)

    // Baseline the session total BEFORE any live tool-result token accrual:
    // the per-turn delta must stay this turn's own contribution, not the
    // live-updated running total.
    const turnStartTotal = getState().tokenTotals.total;
    const turn = createTurnPresenter({
      entries: state.entries,
      append: pushLines,
      width: () => process.stdout.columns ?? 80,
      requestRender: scheduler.request,
      nextMessageSeq,
      prevTokenTotal: () => turnStartTotal,
      onRoundDelta: (delta) => addLiveCompletionTokens(delta),
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
    const baseOnToolResult = turn.events.onToolResult;
    turn.events.onToolResult = (id, name, ok, result, error, usage, promptDelta, resultTokens) => {
      baseOnToolResult?.(id, name, ok, result, error, usage, promptDelta, resultTokens);
    };
    turn.begin(prompt);
    input.reset();
    setState({ follow: true });
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
   * Abort the in-flight turn (Esc with no focused entry): send the
   * `turn.abort` message. The session stream frames the terminal `turn.aborted`
   * event, which settles `runTurn` and stops the spinner through the normal
   * completion path — the abort call itself only fires the request. A
   * transport failure here is logged; the turn keeps running either way.
   */
  const abortActiveTurn = (): void => {
    if (!getState().busy || client.sessionId === undefined) return;
    void client.abortTurn().catch((err: unknown) => {
      pushLines(
        "error",
        noticeLine("error", "abort failed", err instanceof Error ? err.message : String(err)),
      );
    });
  };

  // ---- copy / output sinks ----------------------------------------
  /** Toast: a one-row drawer child (registered like the spinner) that shows
   *  the copy/save confirmation for 3 seconds, then collapses to nothing. */
  const toast = new ToastComponent();
  registerDrawerChild(toast);
  /** Clipboard sink: write the content with wl-copy. A missing
   *  wl-copy (or a spawn failure) surfaces as an error notice; a successful
   *  copy shows the 📋 toast. */
  const copyToClipboard = (request: CopyRequest): void => {
    const outcome = runWlCopy(request.content);
    if (outcome.ok) {
      toast.show(`📋 entry \`${request.itemId}\` copied to the system clipboard`);
      return;
    }
    pushLines("error", noticeLine("error", "copy failed", outcome.error));
  };

  /** File sink: write `out/<session id>_<item id>.md` relative to
   *  the cwd (the file lives under the directory yog-client-tui runs in,
   *  not under ~/.config), then show the 💾 toast. */
  const outputToFile = (request: CopyRequest): void => {
    const filename = `${request.itemId}.md`;
    try {
      mkdirSync("out", { recursive: true });
      writeFileSync(join("out", filename), request.content, "utf8");
    } catch (err) {
      pushLines(
        "error",
        noticeLine("error", "output failed", err instanceof Error ? err.message : String(err)),
      );
      return;
    }
    toast.show(`💾 entry \`${request.itemId}\` saved to \`out/${filename}\``);
  };
  // ---- components --------------------------------------------------------
  const viewport = new ChatViewport();
  const input = new InputComponent();
  const status = new StatusComponent();
  const drawer = new DrawerComponent();
  // Top-level focus ring: the log and the input are the two ring targets.
  viewport.ring = "log";
  input.ring = "input";
  const chain: readonly Component[] = [viewport, input, drawer, status];

  /** The copy/output dispatch the viewport asks for: build the
   *  request from the focused entry, then run the sink. The sinks live
   *  here because fs/process access is composition-root-only. */
  const requestCopy = (entry: LogEntry, upper: boolean): CopyRequest | null => {
    const sessionId = client.sessionId;
    if (entry.kind === "tool" || entry.kind === "toolResult" || entry.kind === "chunk") {
      return toolCopyRequest(entry, sessionId, upper);
    }
    if (entry.kind === "user" || entry.kind === "assistant") {
      return proseCopyRequest(entry, sessionId, upper);
    }
    return null;
  };
  /** Table copy: the TABLE is the copy unit at the inner ring — its raw
   *  Markdown re-serialized from the parsed columns/rows, identified by
   *  the parent's item id plus the table's child position (the
   *  table index is the child id — it matches what the focus ring
   *  walks). Shift never reaches this path (the viewport routes it to
   *  the parent entry). */
  const requestTableCopy = (entry: LogEntry, table: number): CopyRequest | null => {
    if (entry.kind !== "user" && entry.kind !== "assistant") return null;
    const sections = splitTableSections(entry.lines.join("\n")).filter((s) => s.kind === "table");
    const section = sections[table];
    if (section === undefined || section.kind !== "table") return null;
    return tableCopyRequest(entry, section.table, table, client.sessionId);
  };
  /** Decline tracer: a copy/output key that produced no request shows WHY
   *  in the debug chunk (kind/copyIds/ring state) — the missing-toast
   *  diagnosis path (#109). */
  const traceDecline = (entry: LogEntry, upper: boolean, unit: string): void => {
    if (!keyLoggerOn) return;
    emitDebug([
      `copy declined · unit=${unit} kind=${entry.kind} upper=${upper} item=${entry.copyIds?.itemId ?? "none"}`,
    ]);
  };
  viewport.copyActions = {
    request: (entry, upper) => {
      const req = requestCopy(entry, upper);
      if (req === null) traceDecline(entry, upper, "entry");
      return req;
    },
    requestTable: (entry, table) => {
      const req = requestTableCopy(entry, table);
      if (req === null) traceDecline(entry, false, `table${table}`);
      return req;
    },
    copy: (request) => copyToClipboard(request),
    output: (request) => outputToFile(request),
  };
  /** Rows the composition consumes from the viewport for the log gap: the
   *  drawer's top padding is that gap when the drawer is visible (one row),
   *  and the composition's own blank row is the gap when it is collapsed
   *  (zero — the blank reuses or replaces a viewport row in place). */
  const drawerGap = (cols: number): number => (drawer.measure(cols) > 0 ? 1 : 0);

  /** Rows available to the log viewport in the current terminal layout. */
  const viewportRows = (): number =>
    Math.max(
      1,
      (process.stdout.rows ?? 24) -
        input.measure(process.stdout.columns ?? 80) -
        drawer.measure(process.stdout.columns ?? 80) -
        status.measure(process.stdout.columns ?? 80) +
        drawerGap(process.stdout.columns ?? 80),
    );

  /**
   * Quit: restore the terminal and exit. The session is NOT deleted and the
   * in-flight turn, if any, is NOT aborted — turns are wire-independent (yog
   * contract, disconnect policy), so the server keeps running the turn to
   * its terminal state after the client hangs up, and the next launch
   * rehydrates the transcript including this turn's result (the bare hang-up
   * is what detaches the session, and a hard end is a future server-side purge
   * command, not the quit path).
   */
  const quit = async (code: number): Promise<void> => {
    if (quitting) return;
    quitting = true;
    generating.stop();
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
  /**
   * Key logger: `YOG_DEBUG_KEYS=1` adds the key/char/paste diagnostics to the
   * debug chunk stream; a path (`YOG_DEBUG_KEYS=/some/file`) does that AND
   * appends a hex dump of every raw input chunk to the file. Both are gated
   * on `YOG_DEBUG=1` (debug chunks) — `YOG_DEBUG_KEYS` alone stays inert.
   */
  const keyLoggerOn = isKeyLogEnabled();
  const keyEnv = keyLogPath();
  // "1" marks chunk-only logging; a path also gets raw hex dumps.
  const keyDebugPath = keyLoggerOn && keyEnv !== "1" ? keyEnv : undefined;
  setKeyDumpSink(
    keyDebugPath === undefined
      ? undefined
      : (raw: string) => {
          appendFileSync(keyDebugPath, `${Buffer.from(raw, "utf8").toString("hex")}\n`);
        },
  );
  /** Raw-input decoder (sequences, chars, bracketed paste framing). */
  const decodeInput = createInputDecoder({
    onSequence: (seq) => {
      const code = Buffer.from(seq, "utf8").toString("hex");
      if (keyLoggerOn) emitDebug([`key ${code}`], seq);
      const routed = routeKey(chain, seq, globals);
      if (keyLoggerOn)
        emitDebug([`key ${code} ${routed ? "handled" : "unhandled"} ring=${getTopLevel()}`]);
    },
    onChar: (ch) => {
      const code = Buffer.from(ch, "utf8").toString("hex");
      if (keyLoggerOn) emitDebug([`char ${code}`], ch);
      const routed = routeChar(chain, ch, globals);
      if (keyLoggerOn)
        emitDebug([`char ${code} ${routed ? "handled" : "unhandled"} ring=${getTopLevel()}`]);
    },
    onPasteEnd: (content) => {
      if (keyLoggerOn) emitDebug([`paste ${Buffer.byteLength(content, "utf8")} bytes`], content);
      input.paste(content);
    },
  });
  const handleData = (chunk: string): void => {
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
      // No blank-screen flash (#67): do NOT clear first. The mangled frame
      // stays visible until the new frame is ready, then swaps as one
      // diff-painted write. `resetFrameCache` drops the diff baseline so
      // the next write is a full repaint (the terminal already reflowed
      // its rows, so the old baseline is meaningless) — but the repaint
      // itself is the swap: HOME + full frame, no intermediate blank.
      resetFrameCache();
      draw();
    };
    process.stdout.on("resize", onResize);
    process.on("SIGWINCH", onResize);
    process.on("SIGTERM", () => void quit(0));
  };

  // 3. Seed the store: startup banner, then the rehydrated transcript and
  //    startup notes (new/resumed/stale-id) already gathered above.
  setState({
    entries: [...bannerEntries(), ...seedEntries],
    model: config.model,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
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
  // 5. Placeholder-first rehydrate (#67): the first frame above painted
  //    placeholders instantly; now swap real entries in bottom-up.
  driveRehydrate();
}

main();
