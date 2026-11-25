/**
 * Transcript conversion — server wire rows → presenter-facing display
 * entries. Pure and terminal-free: `core` remains the home of
 * transcript-shaped data independent of the transport.
 *
 * The server owns the canonical transcript; the TUI only rehydrates its
 * visible log from it at startup. Conversion is full-fidelity: every row
 * maps to an entry with all available data (assistant tool-call rows keep
 * their calls in `raw.toolCalls`; tool result rows keep their payload in
 * `raw.content`), nothing is truncated, summarized, or skipped. Malformed
 * rows are tolerated defensively — conversion never throws.
 */
import type { TranscriptMessage, TokenUsage } from "../client/index.ts";
import type { TranscriptTurnMetrics } from "./turnMetrics.ts";
import { estimateTokenCount } from "tokenx";

/** Roles a transcript row can carry. */
export type TranscriptRole = "user" | "assistant" | "system" | "tool";

/** One presenter-facing transcript entry (one wire row each). */
export interface TranscriptEntry {
  role: TranscriptRole;
  text: string;
  /** The raw wire row, preserved verbatim for rich rendering. */
  raw: TranscriptMessage;
}

/** The value as a plain object (arrays and primitives decline). */
function plainObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** One string field of an object (other types read as ""). */
function stringField(obj: Record<string, unknown>, key: string): string {
  return typeof obj[key] === "string" ? (obj[key] as string) : "";
}

/** One decoded wire tool call: id/name may be empty (see decodeToolCalls). */
interface WireToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Decode one OpenAI-shaped call object; undefined when it is not an object. */
function decodeToolCall(item: unknown): WireToolCall | undefined {
  const obj = plainObject(item);
  if (obj === undefined) return undefined;
  const fn = plainObject(obj["function"]) ?? {};
  const call: WireToolCall = {
    id: stringField(obj, "id"),
    name: stringField(fn, "name"),
    arguments: stringField(fn, "arguments"),
  };
  return call.id === "" && call.name === "" ? undefined : call;
}

/**
 * Decode an assistant row's `toolCalls` array: the wire carries OpenAI-shaped
 * calls (`{ id, type, function: { name, arguments } }`, arguments as an
 * accumulated JSON *string*). Returns `[]` for absent/malformed data; rows
 * with neither an id nor a name are skipped.
 */
export function decodeToolCalls(raw: unknown): WireToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => decodeToolCall(item))
    .filter((call): call is WireToolCall => call !== undefined);
}

/** The `{ error }` field of a parsed result (objects only); undefined when
 *  the result carries no error string. */
function errorFieldOf(value: unknown): string | undefined {
  const obj = plainObject(value);
  const error = obj?.["error"];
  return typeof error === "string" ? error : undefined;
}

/**
 * Decode a tool result row's payload from its `content` (the server stores
 * the JSON-stringified result). Returns the parsed value plus an `ok` flag —
 * a `{ error }`-shaped result is a failure; anything unparseable passes
 * through as the raw string.
 */
export function decodeToolResult(m: TranscriptMessage): {
  ok: boolean;
  value: unknown;
  error?: string;
} {
  return decodeToolResultText(contentOf2(m));
}

/** Parse a result row's content text into the decoded shape. */
function decodeToolResultText(text: string): {
  ok: boolean;
  value: unknown;
  error?: string;
} {
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    /* not JSON: keep the raw text as the value */
  }
  const error = errorFieldOf(value);
  return error === undefined ? { ok: true, value } : { ok: false, value, error };
}

/** A finite number, or undefined (the only numeric shape callers accept). */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Normalize a per-turn usage payload into a `TokenUsage` (numeric, finite
 * fields only). Returns `undefined` when nothing usable is present so
 * callers can treat the turn as having no usage (never throw).
 */
export function decodeTurnUsage(value: unknown): TokenUsage | undefined {
  const rec = plainObject(value);
  if (rec === undefined) return undefined;
  const keys = ["prompt_tokens", "completion_tokens", "total_tokens"] as const;
  const picked = keys.map((key) => finiteNumber(rec[key]));
  const usage: TokenUsage = {};
  keys.forEach((key, i) => {
    const n = picked[i];
    if (n !== undefined) usage[key] = n;
  });
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** The current context weight: the last known absolute total (0 when none). */
export function finalContextTotal(
  turns: ReadonlyArray<{ usage?: TokenUsage } | undefined> | undefined,
): number {
  if (!Array.isArray(turns)) return 0;
  const totals = turns
    .map((turn) => finiteNumber(turn?.usage?.total_tokens))
    .filter((n): n is number => n !== undefined && n > 0);
  return totals.length > 0 ? (totals[totals.length - 1] as number) : 0;
}
/** One row's estimated token weight: its content plus its tool calls. */
function rowTokenEstimate(m: { content?: string; toolCalls?: unknown }): number {
  let total = 0;
  if (typeof m.content === "string" && m.content !== "") total += estimateTokenCount(m.content);
  if (m.toolCalls !== undefined) {
    try {
      total += estimateTokenCount(JSON.stringify(m.toolCalls));
    } catch {
      // ignore malformed tool-call payloads
    }
  }
  return total;
}

/**
 * Estimate the current context weight directly from the transcript rows when
 * no provider-reported totals exist (e.g. a fresh handoff/compaction session
 * whose artifact has not been through a model round yet). Uses tokenx on the
 * serialized row text — an estimate, so callers label it with "~".
 */
export function estimatedContextTotal(
  messages: ReadonlyArray<{ content?: string; toolCalls?: unknown } | undefined> | undefined,
): number {
  if (!Array.isArray(messages)) return 0;
  const rows = messages.filter(
    (m): m is { content?: string; toolCalls?: unknown } => m !== null && typeof m === "object",
  );
  return rows.reduce((total, row) => total + rowTokenEstimate(row), 0);
}

/**
 * Reduce per-turn metrics (absolute token totals as reported per turn) to
 * the incremental delta each turn contributed: total after the turn minus
 * total before it, with a baseline of 0 for the first known total. The
 * reported total is the full hydrated-context size, so the per-turn summary
 * line should show this delta, not the session total. Turns without a
 * numeric total are kept for their duration but contribute no usage, and
 * deltas that would be negative (provider inconsistency) are omitted rather
 * than shown as a nonsensical decrease.
 */
/** The turn fields a captured transcript dump carries. */
interface CapturedTurn {
  turnId: number;
  usage?: TokenUsage;
  durationMs?: number;
}

/** A finite nonnegative turn id, or undefined. */
function turnIdOf(turn: CapturedTurn): number | undefined {
  const id = turn.turnId;
  return typeof id === "number" && Number.isFinite(id) ? id : undefined;
}

/**
 * One turn's metrics against the total BEFORE it: the delta each turn
 * contributed (`delta > 0` — a negative or zero delta is a provider
 * inconsistency, omitted rather than shown as a nonsensical decrease).
 * A turn with no usage contributes only its duration (or nothing, when
 * it has neither — the caller drops empty entries).
 */
function turnMetrics(turn: CapturedTurn, prevTotal: number): TranscriptTurnMetrics {
  const metrics: TranscriptTurnMetrics = {};
  const duration = finiteNumber(turn.durationMs);
  if (duration !== undefined) metrics.durationMs = duration;
  const delta = reportedTotalOf(turn) - prevTotal;
  if (reportedTotalOf(turn) > 0 && delta > 0) metrics.usage = { total_tokens: delta };
  return metrics;
}

/** Sort key of a captured turn: its finite turn id (guards removed upstream). */
function byTurnId(a: CapturedTurn, b: CapturedTurn): number {
  return (turnIdOf(a) as number) - (turnIdOf(b) as number);
}

/** Is the metrics entry worth a map slot: it carries anything at all? */
function hasMetrics(metrics: TranscriptTurnMetrics): boolean {
  return metrics.usage !== undefined || metrics.durationMs !== undefined;
}

/** The captured turns with usable ids, in turn order. */
function orderedTurns(
  turns: ReadonlyArray<{ turnId: number; usage?: TokenUsage; durationMs?: number }>,
): CapturedTurn[] {
  return turns
    .filter((t): t is CapturedTurn => t !== null && typeof t === "object")
    .filter((t) => turnIdOf(t) !== undefined)
    .sort(byTurnId);
}

/** The turn's absolute context total (the running-total input), 0 when absent. */
function reportedTotalOf(turn: CapturedTurn): number {
  return finiteNumber(turn.usage?.total_tokens) ?? 0;
}

export function perTurnDeltas(
  turns: ReadonlyArray<{ turnId: number; usage?: TokenUsage; durationMs?: number }> | undefined,
): Map<number, TranscriptTurnMetrics> {
  const out = new Map<number, TranscriptTurnMetrics>();
  if (!Array.isArray(turns)) return out;
  let prevTotal = 0;
  for (const turn of orderedTurns(turns)) {
    const metrics = turnMetrics(turn, prevTotal);
    prevTotal = Math.max(prevTotal, reportedTotalOf(turn));
    if (hasMetrics(metrics)) out.set(turnIdOf(turn) as number, metrics);
  }
  return out;
}

/** The result content pretty-printed as JSON (objects only); undefined when
 *  the content is absent or not a JSON object. */
function prettyJsonOf(content: string | undefined): string | undefined {
  if (content === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed !== null && typeof parsed === "object"
      ? JSON.stringify(parsed, null, 2)
      : undefined;
  } catch {
    return undefined; // not JSON — the raw text is the value
  }
}

/** Pretty text for a tool result row: `name → <result>`. */
function toolResultText(m: TranscriptMessage): string {
  const hasName = typeof m.name === "string" && m.name !== "";
  const name = hasName ? m.name : (m.toolCallId ?? "tool");
  const content = contentOf(m);
  const right = prettyJsonOf(content) ?? (content === "" ? "(no result)" : content);
  return `${name} → ${right}`;
}

/** Tool-call summary for an assistant row: `tool call: a, b`. */
function toolCallSummary(m: TranscriptMessage): string {
  const names = decodeToolCalls(m.toolCalls)
    .map((c) => c.name || "tool")
    .join(", ");
  return `tool call: ${names === "" ? "tool" : names}`;
}

/** The row's string content (other types read as ""). */
function contentOf2(m: TranscriptMessage): string {
  return typeof m.content === "string" ? m.content : "";
}

/**
 * Primary display text for one wire row (derived from every field present).
 * Plain rows use their content verbatim; assistant rows carrying tool calls
 * summarize them (the renderer builds the rich call line from `raw`); tool
 * result rows render as `name → result`.
 */
export function transcriptText(m: TranscriptMessage): string {
  if (m.role === "tool") return toolResultText(m);
  if (m.role !== "assistant" || m.toolCalls === undefined) return contentOf(m);
  return assistantText(contentOf(m), toolCallSummary(m));
}

/** Assistant display text: the summary carries the line when the prose is
 *  empty; prose and summary compose when both exist. */
function assistantText(content: string, summary: string): string {
  if (content === "") return summary;
  return `${content} [${summary}]`;
}

/**
 * Expand a transcript payload into display entries in seq order — one entry
 * per row, every message kind (user/assistant/system/tool) included.
 * Unknown roles normalize to `system` entries (defensive, never a
 * fallback mode); malformed rows — non-objects or roleless — are skipped
 * without throwing.
 */
/** The display role of one wire row: user/assistant/tool pass through,
 *  everything else renders as system (unknown roles normalized, never a
 *  fallback mode). */
function displayRoleOf(role: unknown): TranscriptRole {
  return role === "user" || role === "assistant" || role === "tool" ? role : "system";
}

/** Is the row well-formed enough to convert: a plain object with a role. */
function isConvertible(m: TranscriptMessage): boolean {
  return plainObject(m) !== undefined && typeof m.role === "string";
}

export function toTranscriptEntries(messages: TranscriptMessage[]): TranscriptEntry[] {
  return messages
    .filter((m) => isConvertible(m))
    .map((m) => ({ role: displayRoleOf(m.role), text: transcriptText(m), raw: m }));
}
/** The row's string content (other types read as ""). */
function contentOf(m: TranscriptMessage): string {
  return typeof m.content === "string" ? m.content : "";
}

/** Decode a tool result row by its content text (the rehydrate path
 *  needs the PARSE — the ok/error flags it already computes on the way —
 *  and harness_notice decoding reuses the same tolerant parse). */
export function decodeResultContent(text: unknown): {
  ok: boolean;
  value: unknown;
  error?: string;
} {
  return decodeToolResultText(typeof text === "string" ? text : "");
}
