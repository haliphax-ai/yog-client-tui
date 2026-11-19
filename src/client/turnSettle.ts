/**
 * Turn settling for the transport: racing the long-lived stream's death
 * against the arrival of a terminal event, and reading the outcome off
 * the observation once the race has settled.
 *
 * The session stream stays open (with heartbeats) past the turn's
 * terminal event, so awaiting the closed stream alone would hang forever
 * once `turn.finished`/`turn.aborted`/`error` has already landed — the
 * race is what lets a successful turn settle promptly.
 */
import type { TurnEnvelope, TurnEvents, TurnOutcome } from "./wire.ts";
import {
  directOutcome,
  emptyRecoveryOutcome,
  recoveredOutcome,
  streamGapOutcome,
  TurnObservation,
} from "./turnOutcome.ts";

/** Race the stream's death against the arrival of a terminal event:
 *  `[error, false]` when the stream died first, `[undefined, true]` when
 *  a terminal event landed. */
export async function awaitTerminal(
  streamDone: Promise<Error | undefined>,
  terminal: Promise<void>,
): Promise<[Error | undefined, boolean]> {
  const [streamError, terminalWon] = await Promise.race([
    streamDone.then((err) => [err, false] as const),
    terminal.then(() => [undefined, true] as const),
  ]);
  return [streamError, terminalWon];
}

/** The turn under settlement: the observation the envelopes fed, the UI
 *  callbacks, and the shared envelope handler (recovery replays through
 *  the same one). */
interface Settling {
  observed: TurnObservation;
  events: TurnEvents;
  handle: (ev: TurnEnvelope) => void;
}

/** How the race resolved: the stream error (undefined = clean end) and
 *  whether a terminal event won the race. */
interface Raced {
  streamError?: Error;
  terminalWon: boolean;
}

/** One `turn.get` replay (the transport's recovery path). */
export type Recover = (turnId: string) => Promise<boolean>;

/**
 * Read the outcome off the observation once the race has settled:
 * - the stream died mid-turn → replay the stored turn events (`turn.get`);
 * - a terminal event landed → the direct outcome;
 * - the stream ended cleanly with no terminal event → a server-side gap
 *   (an older server that silently drops the turn): recover the stored
 *   turn when its id is known — the events are persisted server-side —
 *   and only report a bare failure when recovery is impossible or empty.
 */
export async function settleTurn(
  sessionId: string,
  turn: Settling,
  raced: Raced,
  recover: Recover,
): Promise<TurnOutcome> {
  const { observed } = turn;
  const interrupted = !raced.terminalWon && raced.streamError !== undefined;
  if (interrupted)
    return await settleInterrupted(sessionId, turn, raced.streamError as Error, recover);
  if (observed.sawFinished) return directOutcome(observed);
  if (observed.turnId !== undefined) {
    const recovered = await recover(observed.turnId);
    const silentReplay =
      recovered &&
      !observed.sawFinished &&
      !observed.sawAborted &&
      observed.serverError === undefined;
    if (silentReplay) return emptyRecoveryOutcome();
    if (recovered) return recoveredOutcome(observed, true);
  }
  return streamGapOutcome(observed);
}

/** The stream died mid-turn: replay the stored turn events (`turn.get`).
 *  A turn whose id was never announced cannot be replayed — the failure
 *  carries the stream error instead. */
async function settleInterrupted(
  sessionId: string,
  turn: Settling,
  streamError: Error,
  recover: Recover,
): Promise<TurnOutcome> {
  const { observed, events } = turn;
  if (observed.turnId === undefined) {
    return {
      ok: false,
      recovered: false,
      aborted: false,
      error: observed.serverError,
      failure: `turn stream interrupted (${streamError.message}) before a turnId was announced`,
    };
  }
  const recovered = await recover(observed.turnId);
  events.onRecovered?.();
  return recoveredOutcome(observed, recovered);
}
