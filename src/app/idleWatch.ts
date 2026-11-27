/**
 * Idle watch (yog#85 client track): a session-lifetime stream so the
 * client sees turns it did not start — a wake turn delivering background
 * job results — as they happen, instead of learning about them on the
 * next submit (the submit-time sync). While a user turn is live, its own
 * stream owns rendering; the watch hands rendering back on return to
 * idle.
 *
 * Disconnect safety: wake turns are `revive` turns with no bound stream,
 * so closing the watch cannot abort one (#31 keeps user turns
 * disconnect-coupled; foreign turns are not).
 *
 * Stream death used to strand the watch for the session's remaining life:
 * `closed` just cleared the handle and nothing ever re-armed it except
 * the next submit's finally block — every later wake delivery sat
 * invisible until the user typed (#144). `arm` now re-arms itself with a
 * backoff (the daemon restart case: an idle retry keeps the probe
 * harmless), stops retrying only on the errors retrying cannot fix (a
 * session the server has dropped — a restart can be picked up by
 * relaunching the client), and `disarm` cancels any pending retry so a
 * user turn starting mid-backoff does not double-arm.
 */
import { TurnObservation, YogError, turnEnvelopeHandler } from "../client/index.ts";
import type { TurnEvents, YogClient } from "../client/index.ts";
import { createTurnPresenter, setState, type LogEntry } from "../core/index.ts";
import type { TokenUsage } from "../client/index.ts";
import { getState } from "../core/index.ts";
import { noticeLine } from "../core/index.ts";
import { emitDebug, isDebugEnabled } from "../ui/index.ts";

/** The presenter host the watch builds its own presenter over (the
 *  shared log; identical shape to the submit path's host). */
export type IdleWatchHost = Parameters<typeof createTurnPresenter>[0];

export interface IdleWatch {
  /** Arm the watch (safe to call repeatedly). */
  arm(): void;
  /** Disarm while a user turn is live (its stream owns rendering). */
  disarm(): void;
  /**
   * Flush the deferred foreign rows (the user-turn seam): the user's
   * turn just ended — buffered wake deliveries land now, after the
   * user's content, without waiting for the next append.
   */
  flushSeam(): void;
  /** Discard buffered foreign rows without rendering them (the submit
   *  path dropped the stream mid-busy; the next transcript sync recovers
   *  anything the user never saw from the server tail). */
  dropSeam(): void;
}

/** Re-arm backoff: first retry immediately-ish, then 1 s, doubling. */
const REARM_BASE_MS = 1000;
/** Backoff ceiling — a dead daemon is retried about every 30 s, forever. */
const REARM_MAX_MS = 30_000;

/**
 * A seam-aware host wrapper: while the user's own turn is busy, foreign
 * deliveries (a wake turn streaming its results) do not interleave with
 * the user's prose — their entries collect in a side buffer and flush at
 * the seam (busy → false), landing after the user's turn content.
 *
 * The WHOLE host surface is covered, not just `append`: the presenter's
 * prose stream and tool handlers mutate `host.entries` directly (they
 * must — a delta extends the tail block in place, a result splices after
 * its call line), so while busy `entries` reads as a scratch array that
 * flush replays into the shared log in arrival order. The live binding
 * to the shared log is kept explicitly (a `...host` spread would capture
 * the array once and go stale on the first rebuild — the composition
 * root's getter exists precisely to prevent that).
 */
export function deferWhileBusy(
  host: IdleWatchHost,
  isBusy: () => boolean,
): { host: IdleWatchHost; flush: () => void; drop: () => void } {
  /** The scratch array the presenter writes into while busy. */
  let scratch: LogEntry[] | undefined;
  const flush = (): void => {
    const queued = scratch;
    scratch = undefined;
    if (queued === undefined || queued.length === 0) return;
    host.entries.push(...queued);
    // One notification for the whole batch (the buffered appends skipped
    // theirs while busy; the caller's busy→false edge re-notifies too).
    host.requestRender();
  };
  const drop = (): void => {
    scratch = undefined;
  };
  const seamHost: IdleWatchHost = {
    get entries() {
      return isBusy() ? (scratch ??= []) : host.entries;
    },
    append: (kind, lines) => {
      if (isBusy()) {
        // The entry object itself (the same shape pushLines builds), so
        // scratch replays it byte-identically at flush time.
        (scratch ??= []).push({ kind, lines });
        return;
      }
      host.append(kind, lines);
      flush();
    },
    width: host.width,
    requestRender: host.requestRender,
    nextMessageSeq: host.nextMessageSeq,
  };
  if (host.prevTokenTotal !== undefined) seamHost.prevTokenTotal = host.prevTokenTotal;
  if (host.onRoundDelta !== undefined) seamHost.onRoundDelta = host.onRoundDelta;
  return { host: seamHost, flush, drop };
}

/** Whether `err` is a stream-open failure re-arming cannot fix: a
 *  `YogError` (`code` field) the server answered with — `unknown_session`
 *  means the server dropped the session; everything else (transports,
 *  restarts, timeouts) is retryable. */
function unrecoverableStreamError(err: unknown): boolean {
  return err instanceof YogError && err.code === "unknown_session";
}

/** The watch's event surface over one presenter: the wake-turn
 *  `turn.started` announcement (holes 1–2, #144) plus the job-event fan
 *  through to the drawer. Split out of `startIdleWatch` for complexity. */
function watchEvents(
  seam: { host: IdleWatchHost },
  base: TurnEvents,
  onJobEvent: ((type: string, data: Record<string, unknown>) => void) | undefined,
  onUsage: ((usage: TokenUsage) => void) | undefined,
): TurnEvents {
  return {
    ...base,
    /**
     * `turn.started` on the watch stream: a foreign turn is live. The
     * announcement used to wait for the turn's first delta — for a wake
     * turn that renders its settle pairs only after the model's first
     * round trip, an 80+ second silent gap (#144). One quiet line now
     * lands at t=0; the deliveries follow through the normal paths.
     */
    onStarted: (_turnId: string, _model: string, wake?: boolean): void => {
      // The spinner reflects ANY generation in flight — the user's own
      // (`busy`, the submit path owns it) or a foreign turn's (`busyForeign`,
      // owned HERE). A wake turn shows the same honest "generating" row.
      setState({ busyForeign: true });
      if (wake !== true) return;
      seam.host.append("notice", noticeLine("notice", "background jobs", "delivering"));
    },
    onFinish: (durationMs, stopReason, usage) => {
      setState({ busyForeign: false });
      if (usage !== undefined) onUsage?.(usage);
      base.onFinish?.(durationMs, stopReason, usage);
    },
    onAborted: (reason, usage) => {
      setState({ busyForeign: false });
      if (usage !== undefined) onUsage?.(usage);
      base.onAborted?.(reason, usage);
    },
    onError: (code, message) => {
      setState({ busyForeign: false });
      base.onError?.(code, message);
    },
    onJobEvent: (type: string, data: Record<string, unknown>) => {
      base.onJobEvent?.(type, data);
      onJobEvent?.(type, data);
    },
  };
}

/** Cancel a pending re-arm and reset the backoff (both lifecycle edges:
 *  a fresh `arm` retries at full speed; a `disarm` must not let a
 *  queued timer double-arm underneath the user's turn). */
function cancelRearm(timer: ReturnType<typeof setTimeout> | undefined): undefined {
  if (timer !== undefined) clearTimeout(timer);
  return undefined;
}

export function startIdleWatch(
  client: YogClient,
  hostInput: IdleWatchHost,
  onJobEvent?: (type: string, data: Record<string, unknown>) => void,
): IdleWatch {
  // The busy flag is the USER'S OWN TURN (the submit path owns it). The
  // watch never touches it: foreign wake deliveries defer while the user
  // is busy and flush at the seam (flushSeam — the submit path calls it
  // on the busy-false edge). The spinner reflects only the user's own
  // generation; no more foreign spinner ghosts.
  const seam = deferWhileBusy(hostInput, () => getState().busy);
  const presenter = createTurnPresenter(seam.host);
  let stream: ReturnType<YogClient["openStream"]> | undefined;
  let rearmTimer: ReturnType<typeof setTimeout> | undefined;
  let rearmDelay = 0;
  const observed = new TurnObservation();
  // Per-frame debug lines live in git history if ever needed again —
  // they drown the chunk while a turn streams (one line per delta).
  const dbg = (line: string): void => {
    if (isDebugEnabled()) emitDebug([`👁 ${line}`]);
  };
  const onEvent = turnEnvelopeHandler(
    observed,
    watchEvents(seam, presenter.events, onJobEvent, hostInput.onTerminalUsage) as never,
    "",
    () => undefined,
  );

  const arm = (): void => {
    if (stream !== undefined || client.sessionId === undefined) return;
    stream = client.openStream(client.sessionId, onEvent);
    dbg("armed");
    void stream.closed.then((err) => {
      if (stream !== undefined) stream = undefined;
      // Re-arm with backoff — the one self-heal path: SSE streams die
      // (server restart, idle timeout, network blip) and every later
      // wake delivery stayed invisible until the next submit (#144).
      if (err !== undefined && unrecoverableStreamError(err)) {
        dbg(`stream closed permanent (${err.message}) — not re-arming`);
        return;
      }
      rearmDelay = rearmDelay === 0 ? REARM_BASE_MS : Math.min(rearmDelay * 2, REARM_MAX_MS);
      dbg(`stream closed — re-arming in ${rearmDelay}ms`);
      rearmTimer = setTimeout(() => {
        rearmTimer = undefined;
        arm();
      }, rearmDelay);
    });
  };

  return {
    arm(): void {
      dbg(`arm (sessionId=${client.sessionId ?? "none"}, already=${stream !== undefined})`);
      rearmTimer = cancelRearm(rearmTimer);
      rearmDelay = 0;
      arm();
    },
    disarm(): void {
      dbg("disarm");
      rearmTimer = cancelRearm(rearmTimer);
      rearmDelay = 0;
      stream?.close();
      stream = undefined;
    },
    flushSeam(): void {
      seam.flush();
    },
    dropSeam(): void {
      seam.drop();
    },
  };
}
