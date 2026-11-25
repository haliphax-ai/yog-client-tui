/**
 * Entry point / wiring only: terminal lifecycle, key handling, render
 * scheduling, and the config → client → presenter → view pipeline.
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
 *                   Home/End, PgUp/PgDn, Ctrl+A/E/K/U/W, selection, copy,
 *                   case transforms, …). Esc with the ring empty returns
 *                   to the input.
 */
import { configFilePath, loadConfig, loadState, saveState, stateFilePath } from "./config.ts";
import { FOCUS_NONE_TARGET } from "./core/index.ts";
import { getState, setState } from "./core/index.ts";
import { noticeLine } from "./core/index.ts";
import { setDrawerCommands, setServerCommands, type CommandDescriptor } from "./core/index.ts";
import { YogClient, type TranscriptResult } from "./client/index.ts";
import {
  driveRehydrate,
  setTranscriptSyncNotes,
  stageRehydrate,
  statusTotals,
} from "./app/index.ts";
import { pushLines } from "./app/index.ts";
import { resolveSession } from "./app/index.ts";
import { pollRunningTurn } from "./app/index.ts";
import { abortActiveTurn } from "./app/index.ts";
import { submitInput } from "./app/index.ts";
import { setKeyDumpWriter, wireTerminal, type AppHooks, type Terminal } from "./app/index.ts";
import { copyFailureNotice } from "./app/index.ts";
import type { CopyRequest } from "./core/index.ts";
import { ToastComponent } from "./ui/components/index.ts";
import { drawerSlashCommands, registerDrawerChild } from "./ui/components/index.ts";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emitDebug, isDebugEnabled } from "./ui/index.ts";
import type { LogEntry } from "./core/index.ts";

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
  // Pop the kitty keyboard stack entry (the flag-1 push at enter) — CSI < u.
  // The legacy resets ride along so a terminal that never took the push is
  // still fully restored.
  process.stdout.write("\x1b[<u\x1b[?1049l\x1b[?25h\x1b[?2004l");
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

/** The connect/startup outcome the run sequence consumes. */
interface Startup {
  client: YogClient;
  config: { model: string; baseUrl: string };
  contextWindow: number | undefined;
  /** Banner + startup notes + rehydrate seed, in log order. */
  seed: LogEntry[];
  /** Startup notes only (a poll rebuild keeps them ahead of the rows). */
  notes: LogEntry[];
  /** The resume dump, when a session resumed (reconnect pickup). */
  dump?: TranscriptResult;
  runningTurnId?: number;
  resumedTokenWeight: number;
}

/**
 * Probe, resolve the session, and seed the log — the whole startup
 * sequence before the screen is taken over, so failures print plainly
 * and exit non-zero. The registry merge happens here too: advertised
 * commands land in the slash registry with startup notes for collisions
 * and drops (see `core/commands.ts` for the merge rule).
 */
async function connectAndResolve(flags: CliFlags): Promise<Startup> {
  const config = await loadConfig(configFilePath());
  const state = await loadState(stateFilePath());
  const requested = flags.new ? undefined : (flags.session ?? state.lastSessionId ?? undefined);

  const client = new YogClient(config.baseUrl);
  const caps = await client.probe(config.model);
  const contextWindow = caps.contextWindowSizes?.[config.model];
  if (!caps.features.includes("transcript")) {
    throw new Error("server does not advertise the transcript feature; run the current yog");
  }

  const resolved = await resolveSession(client, requested);
  const banner = [
    {
      kind: "notice" as const,
      lines: noticeLine(
        "notice",
        "connected",
        `${config.baseUrl} · contract ${caps.contractVersion} · ` +
          `${caps.models.length} model(s) · ${caps.tools.length} tool(s)`,
      ),
    },
    {
      kind: "notice" as const,
      lines: noticeLine("notice", "model", `${config.model} · /quit exits`),
    },
  ];
  const rejected = setServerCommands(advertiseableCommands(caps));
  for (const descriptor of rejected) {
    resolved.seed.unshift({
      kind: "notice",
      lines: noticeLine(
        "notice",
        "registry",
        `server command /${descriptor.name} collides with a local command; local wins`,
      ),
    });
  }
  return {
    client,
    config,
    contextWindow,
    seed: [...banner, ...resolved.seed],
    notes: resolved.notes,
    dump: resolved.dump,
    runningTurnId: resolved.runningTurnId,
    resumedTokenWeight: resolved.resumedTokenWeight,
  };
}

/** The advertised descriptors whose message the server dispatches (a
 *  descriptor outside the set would wedge on send). */
function advertiseableCommands(caps: {
  commands?: CommandDescriptor[];
  messageTypes?: string[];
}): CommandDescriptor[] {
  const messageTypes = new Set(caps.messageTypes ?? []);
  return (caps.commands ?? []).filter(
    (descriptor) => messageTypes.size === 0 || messageTypes.has(descriptor.message),
  );
}

async function run(argv: readonly string[]): Promise<void> {
  const flags = parseFlags(argv);
  const startup = await connectAndResolve(flags);
  const { client, config } = startup;

  // The `out/` file sink: write `out/<session id>_<item id>.md` relative
  // to the cwd (the file lives under the directory yog-client-tui runs in,
  // not under ~/.config), then show the 💾 toast — fs access stays here at
  // the composition root.
  const outputToFile = (request: CopyRequest): void => {
    const filename = `${request.itemId}.md`;
    try {
      mkdirSync("out", { recursive: true });
      writeFileSync(join("out", filename), request.content, "utf8");
    } catch (err) {
      copyFailureNotice("output failed", err);
      return;
    }
    toast.show(`💾 entry \`${request.itemId}\` saved to \`out/${filename}\``);
  };

  // ---- reconnect pickup (yog#88 / yog#31): a `running` turn at resume —
  // spinner on, a startup note, and a poll that replays each fresh
  // transcript dump through the same rebuild path a resume uses, so
  // completed rows appear before the turn settles.
  let terminal: Terminal | undefined;
  let quitting = false;
  const quit = async (code: number): Promise<void> => {
    if (quitting) return;
    quitting = true;
    terminal?.stopSpinner();
    restoreTerminal();
    process.exit(code);
  };
  const hooks: AppHooks = {
    outputToFile,
    submit: () => {
      if (terminal === undefined) return;
      submitInput(
        {
          client,
          model: config.model,
          input: terminal.input,
          spinner: { start: () => setState({ busy: true }), stop: terminal.stopSpinner },
          scheduler: terminal.scheduler,
          quit: (code) => void quit(code),
          saveState: (id) => saveState(stateFilePath(), { lastSessionId: id }),
        },
        getState().input,
      );
    },
    abortTurn: () => abortActiveTurn(client),
    quit: (code) => void quit(code),
    saveState: (id) => saveState(stateFilePath(), { lastSessionId: id }),
  };

  if (startup.runningTurnId !== undefined) {
    pushLines(
      "notice",
      noticeLine("notice", "turn in flight", "this session has a running turn — generating"),
    );
    pollRunningTurn(client, startup.runningTurnId, [...startup.notes], {
      start: () => setState({ busy: true }),
      stop: () => setState({ busy: false }),
    });
  }
  // Persist the resolved id so the next launch resumes automatically. A
  // startup failure above never reaches this write, so a stored id survives.
  await saveState(stateFilePath(), { lastSessionId: client.sessionId ?? null });

  // The key-logger hex-dump writer (fs stays at the composition root);
  // the toast lives in the terminal, so the file sink forwards through
  // the same component the clipboard path uses.
  const toast = new ToastComponent();
  registerDrawerChild(toast);
  setKeyDumpWriter((path: string, raw: string): void => {
    appendFileSync(
      path,
      `${Buffer.from(raw, "utf8").toString("hex")}
`,
    );
  });

  // Assemble the terminal: components, draw loop, scheduler, key surface.
  terminal = wireTerminal(client, hooks);
  // The drawer children's slash commands (`/jobs` from the jobs view)
  // join the registry through the drawer registry's command hook — one
  // hook point for any drawer feature that wants a command. A server
  // descriptor under the same name still loses (drawer commands merge
  // before server descriptors, and both merge after the frozen locals).
  setDrawerCommands(drawerSlashCommands());
  // The jobs drawer's gate + fetch: the view stays fully collapsed (zero
  // rows) until the server advertises `background-jobs` — the drawer's
  // padded block must never open for a server without the subsystem.
  if (terminal.jobsDrawer !== undefined) {
    terminal.jobsDrawer.wire(
      async () => (await client.getJobs()).jobs ?? [],
      () => (client.capabilities?.features ?? []).includes("background-jobs"),
      (state, detail) => pushLines("notice", noticeLine("notice", `job ${state}`, detail)),
    );
  }
  // The fatal handler draws its notice through the same flush timer.
  fatalScheduler = terminal.scheduler.request;

  // 3. Seed the store: startup banner, then the rehydrated transcript and
  //    startup notes (new/resumed/stale-id) already gathered above.
  setState({
    entries: startup.seed,
    model: config.model,
    ...(startup.contextWindow !== undefined ? { contextWindow: startup.contextWindow } : {}),
    focusTarget: FOCUS_NONE_TARGET,
    // Seed the status-bar total with the restored context so the first live
    // turn after a resume shows only its own incremental tokens.
    tokenTotals: statusTotals(startup.resumedTokenWeight),
  });

  // Client-side debug chunks are seeded when enabled so the mode is visible.
  if (isDebugEnabled()) emitDebug(["client-side debug log enabled"]);

  // 4. Take over the terminal and draw the first frame.
  enterTerminal(terminal, quit);
  terminal.draw();
  // 5. Placeholder-first rehydrate (#67): the first frame above painted
  //    placeholders instantly; now swap real entries in bottom-up.
  //    The submit-time sync (#135) keeps the same notes as its chrome.
  setTranscriptSyncNotes([...startup.notes]);
  if (startup.dump !== undefined) stageRehydrate(startup.dump);
  driveRehydrate();
}

/** Take over the terminal: alternate screen, raw mode, and the resize/
 *  SIGTERM hooks. The resize repaint IS the swap (no blank flash, #67). */
function enterTerminal(terminal: Terminal, quit: (code: number) => Promise<void>): void {
  terminalActive = true;
  process.stdout.write(
    "\x1b[?1049h\x1b[?25l\x1b[?2004h" +
      // Kitty keyboard protocol: flag 1 (disambiguate escape codes) so
      // modifier keys (Ctrl+J for the jobs drawer) arrive as unambiguous
      // CSI-u sequences in supporting terminals instead of colliding with
      // legacy C0 (Ghostty sends plain LF for Ctrl+J otherwise — the
      // input ring treats LF as Enter and submits). Plain keys keep
      // their legacy encoding under flag 1, and a terminal without the
      // protocol ignores the push entirely (Ctrl+J stays the documented
      // /jobs fallback). mode 1 = pop at reset (the restore writes the
      // pop below); CSI < u pops the stack entry on exit.
      "\x1b[>1u" +
      "\x1b[?u" + // query: supporting terminals echo their flags
      "\x1b[2J\x1b[H",
  );
  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", terminal.handleData);

  const onResize = (): void => {
    // No blank-screen flash (#67): do NOT clear first. The mangled frame
    // stays visible until the new frame is ready, then swaps as one
    // diff-painted write. `resetFrameCache` drops the diff baseline so
    // the next write is a full repaint (the terminal already reflowed
    // its rows, so the old baseline is meaningless) — but the repaint
    // itself is the swap: HOME + full frame, no intermediate blank.
    terminal.resetFrame();
    terminal.draw();
  };
  process.stdout.on("resize", onResize);
  process.on("SIGWINCH", onResize);
  process.on("SIGTERM", () => void quit(0));
}

main();
