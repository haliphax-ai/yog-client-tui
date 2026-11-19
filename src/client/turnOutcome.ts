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
 * the failure facts, and the turn id. `runTurn` and the recovery replay
 * both feed this one accumulator, so the outcome is read from a single
 * source of truth instead of a scatter of closure variables.
 */
export class TurnObservation {
  usage: TokenUsage | undefined;
  turnId: string | undefined;
  sawFinished = false;
  sawAborted = false;
  stopReason: string | undefined;
  serverError: string | undefined;
  rateLimitRetries = 0;

  /** Apply one envelope's state effects (the UI callbacks are separate). */
  observe(type: string, data: Record<string, unknown>): void {
    switch (type) {
      case "turn.started":
        this.turnId = typeof data["turnId"] === "string" ? data["turnId"] : this.turnId;
        return;
      case "turn.finished":
        this.sawFinished = true;
        // A stopReason (e.g. "max_rounds") means the server stopped the
        // turn early — surfaced on the outcome and to the UI.
        if (typeof data["stopReason"] === "string" && data["stopReason"] !== "") {
          this.stopReason = data["stopReason"];
        }
        if (typeof data["rateLimitRetries"] === "number") {
          this.rateLimitRetries = data["rateLimitRetries"] as number;
        }
        this.usage = decodeUsage(data["usage"]) ?? this.usage;
        return;
      case "turn.aborted":
        this.sawAborted = true;
        return;
      case "error":
        this.serverError = str(data["message"]) || "unknown error";
        return;
      default:
        return; // unknown events carry no observation state
    }
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
