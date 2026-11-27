/**
 * Reply decoders for the transport: the `turn.get` replay rows and the
 * `turn.abort` result block. Tolerant shapes — absent/malformed fields
 * degrade to their empty form (never throw), matching the wire policy.
 */
import type { AbortTurnResult, ActiveToolCall, TurnEnvelope } from "./wire.ts";
import { str } from "./turnOutcome.ts";

/** One stored turn event row of a `turn.get` reply. */
interface StoredEventRow {
  type?: unknown;
  data?: unknown;
}

/** The event rows of a stored turn (absent on odd payloads). */
function storedEvents(body: Record<string, unknown>): StoredEventRow[] {
  const turn = body["turn"] as { events?: StoredEventRow[] } | undefined;
  return turn?.events ?? [];
}

/** The payload of one stored event row ({} when absent/malformed). */
function storedData(row: StoredEventRow): Record<string, unknown> {
  return row.data !== null && typeof row.data === "object" && !Array.isArray(row.data)
    ? (row.data as Record<string, unknown>)
    : {};
}

/** Replay a stored turn's `{ type, data }` rows through the live handler
 *  (the recovery path — the turn reaches its terminal state offline). */
export function replayStoredTurn(
  body: Record<string, unknown>,
  handle: (ev: TurnEnvelope) => void,
): void {
  for (const row of storedEvents(body)) {
    if (typeof row.type !== "string") continue;
    handle({ type: row.type, data: storedData(row) });
  }
}

/** The `aborted` block of a `turn.abort` reply (absent on odd payloads). */
function abortedBlock(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const block = body["aborted"];
  return block !== null && typeof block === "object" && !Array.isArray(block)
    ? (block as Record<string, unknown>)
    : undefined;
}

/** The active tool call a `turn.abort` reply names (undefined when idle). */
function activeToolCallOf(body: Record<string, unknown>): ActiveToolCall | undefined {
  const call = abortedBlock(body)?.["activeToolCall"];
  if (call === null || typeof call !== "object" || Array.isArray(call)) return undefined;
  const rec = call as Record<string, unknown>;
  return { id: str(rec["id"]), name: str(rec["name"]) };
}

/** Decode a `turn.abort` reply: whether a live turn was unwound, and what
 *  it was running when it was. */
export function abortResultOf(body: Record<string, unknown>): AbortTurnResult {
  const block = abortedBlock(body);
  const requested = block?.["requested"] === true;
  const activeToolCall = activeToolCallOf(body);
  const raw = block?.["backgroundJobs"];
  const backgroundJobs =
    typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : undefined;
  return {
    requested,
    status: requested ? "aborted" : "idle",
    ...(activeToolCall !== undefined ? { activeToolCall } : {}),
    ...(backgroundJobs !== undefined ? { backgroundJobs } : {}),
  };
}

/** The `?model=` query for the capabilities probe (empty when unneeded). */
export function capabilityQuery(model: string | undefined): string {
  return typeof model === "string" && model !== "" ? `?model=${encodeURIComponent(model)}` : "";
}
