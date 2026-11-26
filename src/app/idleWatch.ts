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
import { createTurnPresenter } from "../core/index.ts";
import { emitDebug, isDebugEnabled } from "../ui/index.ts";

/** The presenter host the watch builds its own presenter over (the
 *  shared log; identical shape to the submit path's host). */
export type IdleWatchHost = Parameters<typeof createTurnPresenter>[0];

export interface IdleWatch {
  /** Arm the watch (safe to call repeatedly). */
  arm(): void;
  /** Disarm while a user turn is live (its stream owns rendering). */
  disarm(): void;
}

export function startIdleWatch(
  client: YogClient,
  host: IdleWatchHost,
  busy: { set(flag: boolean): void },
): IdleWatch {
  const presenter = createTurnPresenter(host);
  let stream: ReturnType<YogClient["openStream"]> | undefined;
  let foreign = false;

  const observed = new TurnObservation();
  const base = presenter.events;
  const foreignEnd = (): void => {
    if (foreign) {
      foreign = false;
      busy.set(false);
    }
  };
  const events = {
    ...base,
    onStarted: () => {
      base.onStarted?.(observed.turnId ?? "", "");
      if (!foreign) {
        foreign = true;
        busy.set(true);
      }
    },
    onFinish: (...args: Parameters<NonNullable<typeof base.onFinish>>) => {
      base.onFinish?.(...args);
      foreignEnd();
    },
    onAborted: (...args: Parameters<NonNullable<typeof base.onAborted>>) => {
      base.onAborted?.(...args);
      foreignEnd();
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
  };
}
