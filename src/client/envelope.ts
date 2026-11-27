/**
 * Turn-envelope dispatch for the transport: the per-type UI callbacks one
 * envelope drives, and the typed decoders the payloads need.
 *
 * The handler `runTurn` builds is used by both the live stream and the
 * turn-status recovery replay, so a replayed turn updates the same
 * observation and fires the same callbacks. Unknown events are tolerated
 * (forward compatibility).
 *
 * Terminal settlement is SCOPED (#133): the observation decides which turn
 * id owns the wait (its first `turn.started`), and the settle signal fires
 * only once that turn has been announced. A foreign terminal — the
 * replayed wake turn another stream connection replays, another
 * client's turn — still renders through the UI callbacks, but never
 * settles the submitted turn's wait.
 */
import type { ToolResultEvent, TurnEnvelope, TurnEvents } from "./wire.ts";
import { parseToolArgs, parseUsage } from "./decode.ts";
import { str, TurnObservation } from "./turnOutcome.ts";

/** The `turn.started` event: the stream is live; announce the turn/model. */
function dispatchStarted(
  events: TurnEvents,
  data: Record<string, unknown>,
  observed: TurnObservation,
  model: string,
): void {
  events.onStarted?.(
    observed.turnId ?? "",
    typeof data["model"] === "string" ? data["model"] : model,
    data["wake"] === true,
  );
}

/** The `message.delta` event: an assistant text chunk. */
function dispatchDelta(events: TurnEvents, data: Record<string, unknown>): void {
  if (typeof data["text"] === "string") events.onDelta?.(data["text"]);
}

/** The `rate_limited` event: count the retry, surface the backoff window. */
function dispatchRateLimited(
  events: TurnEvents,
  data: Record<string, unknown>,
  observed: TurnObservation,
): void {
  const delayMs = typeof data["delayMs"] === "number" ? data["delayMs"] : 0;
  const attempt =
    typeof data["attempt"] === "number" ? data["attempt"] : observed.rateLimitRetries + 1;
  const maxAttempts = typeof data["maxAttempts"] === "number" ? data["maxAttempts"] : 0;
  observed.rateLimitRetries += 1;
  events.onRateLimited?.({ attempt, maxAttempts, delayMs });
}

/** The `turn.finished` event: surface duration/stop reason/usage, then
 *  settle the awaiting `runTurn` — but only when the observation is
 *  SCOPED (its turn started). An unscoped terminal is a foreign turn's
 *  (a replayed wake turn ahead of the submitted one): it renders, and
 *  the wait stays armed until the submitted turn settles itself. */
function dispatchFinished(
  events: TurnEvents,
  data: Record<string, unknown>,
  observed: TurnObservation,
  settle: () => void,
): void {
  events.onFinish?.(
    typeof data["durationMs"] === "number" ? data["durationMs"] : 0,
    observed.stopReason,
    observed.usage,
  );
  if (observed.scoped) settle();
}

/** The `turn.aborted` event (terminal): surface the reason, then settle
 *  under the same scope rule as `turn.finished`. */
function dispatchAborted(
  events: TurnEvents,
  data: Record<string, unknown>,
  observed: TurnObservation,
  settle: () => void,
): void {
  events.onAborted?.(str(data["reason"]) || "turn aborted", parseUsage(data["usage"]));
  if (observed.scoped) settle();
}

/** The `error` event (terminal): surface the failure, then settle under
 *  the same scope rule: an unscoped `error` (a foreign turn's failure,
 *  replayed ahead of the submitted turn) renders; the wait stays armed. */
function dispatchError(
  events: TurnEvents,
  data: Record<string, unknown>,
  observed: TurnObservation,
  settle: () => void,
): void {
  events.onError?.(str(data["code"]) || "error", observed.serverError ?? "unknown error");
  if (observed.scoped) settle();
}

/** Decode a `tool.result` payload into the typed event shape: strict on
 *  the number fields (finite, and a positive token estimate), tolerant
 *  everywhere else. */
function toolResultOf(data: Record<string, unknown>): ToolResultEvent {
  const promptDelta =
    typeof data["promptDelta"] === "number" && Number.isFinite(data["promptDelta"])
      ? Math.max(0, data["promptDelta"])
      : undefined;
  const resultTokens =
    typeof data["resultTokens"] === "number" &&
    Number.isFinite(data["resultTokens"]) &&
    (data["resultTokens"] as number) > 0
      ? data["resultTokens"]
      : undefined;
  return {
    id: str(data["id"]),
    name: str(data["name"]),
    ok: data["ok"] === true,
    result: data["result"],
    error: str(data["error"]) || undefined,
    usage: parseUsage(data["usage"]),
    promptDelta,
    resultTokens,
  };
}

/**
 * The envelope handler `runTurn` drives: observe the state effects first
 * (the outcome is read from the accumulator), then dispatch the UI
 * callback for the event type. The observe-first order is what makes the
 * scope rule work: by the time a terminal event dispatches, the
 * observation already knows whether its own `turn.started` has landed.
 */
export function turnEnvelopeHandler(
  observed: TurnObservation,
  events: TurnEvents,
  model: string,
  settle: () => void,
): (ev: TurnEnvelope) => void {
  return (ev: TurnEnvelope): void => {
    const data = ev.data ?? {};
    observed.observe(ev.type, data);
    switch (ev.type) {
      case "turn.started":
        dispatchStarted(events, data, observed, model);
        return;
      case "message.delta":
        dispatchDelta(events, data);
        return;
      case "tool.call":
        events.onToolCall?.(str(data["id"]), str(data["name"]), parseToolArgs(data["args"]));
        return;
      case "tool.result":
        events.onToolResult?.(toolResultOf(data));
        return;
      case "rate_limited":
        dispatchRateLimited(events, data, observed);
        return;
      case "turn.finished":
        dispatchFinished(events, data, observed, settle);
        return;
      case "turn.aborted":
        dispatchAborted(events, data, observed, settle);
        return;
      case "error":
        dispatchError(events, data, observed, settle);
        return;
      default:
        events.onJobEvent?.(ev.type, data);
        return;
    }
  };
}
