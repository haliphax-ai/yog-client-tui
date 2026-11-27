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
 */
import { TurnObservation, turnEnvelopeHandler } from "../client/index.ts";
import type { YogClient } from "../client/index.ts";
import { createTurnPresenter, setState, type LogEntry } from "../core/index.ts";
import { getState } from "../core/index.ts";
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
}

/**
 * A seam-aware host wrapper: while the user's own turn is busy, foreign
 * deliveries (a wake turn streaming its results) do not interleave with
 * the user's prose — their entries queue in a side buffer and flush at
 * the seam (busy → false), landing after the user's turn content.
 */
export function deferWhileBusy(
  host: IdleWatchHost,
  isBusy: () => boolean,
): { host: IdleWatchHost; flush: () => void } {
  let buffer: LogEntry[] | undefined;
  const flush = (): void => {
    if (buffer === undefined) return;
    const queued = buffer;
    buffer = undefined;
    for (const entry of queued) host.append(entry.kind, entry.lines);
  };
  return {
    host: {
      ...host,
      append: (kind: LogEntry["kind"], lines: string[]) => {
        if (isBusy()) {
          (buffer ??= []).push({ kind, lines } as LogEntry);
          return;
        }
        host.append(kind, lines);
        flush();
      },
    },
    flush,
  };
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
  const observed = new TurnObservation();
  const base = presenter.events;
  const events = {
    ...base,
    onJobEvent: (type: string, data: Record<string, unknown>) => {
      base.onJobEvent?.(type, data);
      onJobEvent?.(type, data);
    },
  };
  const dbg = (line: string): void => {
    if (isDebugEnabled()) emitDebug([`👁 ${line}`]);
  };
  // Per-frame debug lines live in git history if ever needed again —
  // they drown the chunk while a turn streams (one line per delta).
  const onEvent = turnEnvelopeHandler(observed, events as never, "", () => undefined);

  return {
    arm(): void {
      dbg(`arm (sessionId=${client.sessionId ?? "none"}, already=${stream !== undefined})`);
      if (stream !== undefined || client.sessionId === undefined) return;
      stream = client.openStream(client.sessionId, onEvent);
      void stream.closed.then(
        () => {
          if (stream !== undefined) stream = undefined;
        },
        () => undefined,
      );
    },
    disarm(): void {
      dbg("disarm");
      stream?.close();
      stream = undefined;
    },
    flushSeam(): void {
      seam.flush();
    },
  };
}
