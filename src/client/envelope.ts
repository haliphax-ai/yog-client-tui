/**
 * Turn-envelope dispatch for the transport: the per-type UI callbacks one
 * envelope drives, and the typed decoders the payloads need.
 *
 * The handler `runTurn` builds is used by both the live stream and the
 * turn-status recovery replay, so a replayed turn updates the same
 * observation and fires the same callbacks. Unknown events are tolerated
 * (forward compatibility).
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
 *  settle the awaiting `runTurn`. */
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
  settle();
}

/** The `turn.aborted` event (terminal): surface the reason, then settle. */
function dispatchAborted(
  events: TurnEvents,
  data: Record<string, unknown>,
  settle: () => void,
): void {
  events.onAborted?.(str(data["reason"]) || "turn aborted", parseUsage(data["usage"]));
  settle();
}

/** The `error` event (terminal): surface the failure, then settle. */
function dispatchError(
  events: TurnEvents,
  data: Record<string, unknown>,
  observed: TurnObservation,
  settle: () => void,
): void {
  events.onError?.(str(data["code"]) || "error", observed.serverError ?? "unknown error");
  settle();
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
 * callback for the event type.
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
        dispatchAborted(events, data, settle);
        return;
      case "error":
        dispatchError(events, data, observed, settle);
        return;
      default:
        return;
    }
  };
}
