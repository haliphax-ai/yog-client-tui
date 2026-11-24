/**
 * Turn outcome accounting for the transport: one turn's envelope
 * observations, and the outcome shapes read from them.
 *
 * `runTurn` and the recovery replay both feed one {@link TurnObservation},
 * so the outcome is read from a single source of truth instead of a
 * scatter of closure variables — and the direct, recovered, and gap
 * paths all build their `TurnOutcome` from the same accumulator.
 */
import type { TokenUsage, TurnOutcome } from "./wire.ts";

/** Read a string field from an event payload ("" when absent/not a string). */
export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * What one turn's envelopes have said so far: the terminal-event flags,
 * both feed this one accumulator, so the outcome is read from a single
 * source of truth instead of a scatter of closure variables. The
 * observation is SCOPED: the first `turn.started` after `runTurn`'s POST
 * names the turn it belongs to, and only that turn's terminal events
 * settle the wait (#133).
 */
export class TurnObservation {
  /** Whether the scope is armed: a `turn.started` has landed and named
   *  the submitted turn. While unarmed, every envelope on the stream
   *  belongs to some EARLIER turn — the server replays a foreign turn
   *  (a wake turn, another client's) ahead of the live traffic — and
   *  its terminal events must settle nothing. */
  scoped = false;
  /** The id of the turn the scope armed on (the submitted turn). Only
   *  its terminal events settle the wait; recovery replays this id. */
  turnId: string | undefined;
  usage: TokenUsage | undefined;
  sawFinished = false;
  sawAborted = false;
  stopReason: string | undefined;
  serverError: string | undefined;
  rateLimitRetries = 0;

  /** Apply one envelope's state effects (the UI callbacks are separate).
   *
   *  The scope rule (#133): the FIRST `turn.started` arms the scope — that
   *  turn is the submitted one (its POST preceded everything this
   *  observation will see). Terminal events land in the observation only
   *  once the scope is armed; an UNARMED terminal (`turn.finished` /
   *  `turn.aborted` / `error` of a foreign turn — a wake turn another
   *  connection replays onto the stream ahead of the submitted turn,
   *  another client's turn) stays OUT of the outcome, so it can never
   *  settle the submitted turn's wait. Render-only events (deltas, tool
   *  rows, later `turn.started` frames) always pass through untouched. */
  observe(type: string, data: Record<string, unknown>): void {
    // The scope gate: a terminal lands only once a `turn.started` armed
    // the scope; the arming event itself routes to its own helper.
    if (type === "turn.started") {
      this.observeStarted(data);
      return;
    }
    if (!this.scoped) return; // foreign terminal: never settles the wait
    switch (type) {
      case "turn.finished":
        this.observeFinished(data);
        break;
      case "turn.aborted":
        this.sawAborted = true;
        break;
      case "error":
        this.serverError = str(data["message"]) || "unknown error";
        break;
      default:
        break; // unknown events carry no observation state
    }
  }

  /** The scope-arming `turn.started`: the FIRST announcement names the
   *  submitted turn; later announcements (a second foreign replay, the
   *  submitted turn re-announced on recovery) are ignored — the scope
   *  holds to the submitted turn's terminal. */
  private observeStarted(data: Record<string, unknown>): void {
    if (this.scoped) return; // already scoped — later announcements never re-arm
    this.scoped = true;
    this.turnId = typeof data["turnId"] === "string" ? data["turnId"] : this.turnId;
  }

  /** The scoped `turn.finished`: the outcome facts ride along (stop reason
   *  for the capped-rounds case, usage, rate-limit retries). */
  private observeFinished(data: Record<string, unknown>): void {
    this.sawFinished = true;
    // A stopReason (e.g. "max_rounds") means the server stopped the turn
    // early — surfaced on the outcome and to the UI.
    if (typeof data["stopReason"] === "string" && data["stopReason"] !== "") {
      this.stopReason = data["stopReason"];
    }
    if (typeof data["rateLimitRetries"] === "number") {
      this.rateLimitRetries = data["rateLimitRetries"] as number;
    }
    this.usage = decodeUsage(data["usage"]) ?? this.usage;
  }
}

/** The `usage` field of an event payload (tolerated shape, see the wire
 *  contract): only numeric (finite) fields are copied; undefined when
 *  none are present. Same decoding the abort path uses inline. */
function decodeUsage(value: unknown): TokenUsage | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  const out: TokenUsage = {};
  let hasNumber = false;
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"] as const) {
    const n = rec[key];
    if (typeof n === "number" && Number.isFinite(n)) {
      out[key] = n;
      hasNumber = true;
    }
  }
  return hasNumber ? out : undefined;
}

/** The outcome spread shared by the direct-finish and recovered paths:
 *  the terminal facts (stop reason, usage, rate-limit retries) ride along
 *  exactly when they were observed. */
function outcomeSpread(o: TurnObservation, sawFinished: boolean): Partial<TurnOutcome> {
  return {
    ...(sawFinished && o.stopReason !== undefined ? { stopReason: o.stopReason } : {}),
    ...(sawFinished && o.usage !== undefined ? { usage: o.usage } : {}),
    ...(o.rateLimitRetries > 0 ? { rateLimitRetries: o.rateLimitRetries } : {}),
  };
}

/** The resolved outcome for a turn that reached a terminal event on the
 *  stream (no recovery): ok unless the server reported an error or the
 *  turn was aborted. */
export function directOutcome(o: TurnObservation): TurnOutcome {
  if (o.serverError !== undefined) {
    return { ok: false, recovered: false, error: o.serverError, aborted: false };
  }
  if (o.sawAborted) return { ok: false, recovered: false, aborted: true };
  return {
    ok: o.sawFinished,
    recovered: false,
    aborted: false,
    ...outcomeSpread(o, o.sawFinished),
  };
}

/** The outcome for the recovery path (the stream died mid-turn or ended
 *  without a terminal event): `recovered` true, success only when the
 *  replay reached a clean finish. */
export function recoveredOutcome(o: TurnObservation, recovered: boolean): TurnOutcome {
  const finished = recovered && o.sawFinished;
  return {
    ok: finished && o.serverError === undefined,
    recovered: true,
    aborted: o.sawAborted,
    ...(o.serverError !== undefined ? { error: o.serverError } : {}),
    ...outcomeSpread(o, finished),
    ...(recovered ? {} : { failure: "turn-status recovery failed" }),
  };
}

/** The bare failure when the stream ended with no terminal event and no
 *  turn id to recover (or the recovery came back empty). */
export function streamGapOutcome(o: TurnObservation): TurnOutcome {
  return {
    ok: false,
    recovered: false,
    error: o.serverError,
    failure: "turn stream ended without a terminal event",
    aborted: false,
  };
}

/** The "recovered but no terminal event" failure: the replay ran but the
 *  stored turn carried nothing terminal — the turn's state is unknown. */
export function emptyRecoveryOutcome(): TurnOutcome {
  return {
    ok: false,
    recovered: true,
    aborted: false,
    failure: "turn recovery returned no terminal event",
  };
}
