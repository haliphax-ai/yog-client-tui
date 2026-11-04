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
import type { TranscriptMessage, TokenUsage } from "../yogClient.ts";

/** Roles a transcript row can carry. */
export type TranscriptRole = "user" | "assistant" | "system" | "tool";

/** One presenter-facing transcript entry (one wire row each). */
export interface TranscriptEntry {
  role: TranscriptRole;
  text: string;
  /** The raw wire row, preserved verbatim for rich rendering. */
  raw: TranscriptMessage;
}

/**
 * Decode an assistant row's `toolCalls` array: the wire carries OpenAI-shaped
 * calls (`{ id, type, function: { name, arguments } }`, arguments as an
 * accumulated JSON *string*). Returns `[]` for absent/malformed data; rows
 * with neither an id nor a name are skipped.
 */
export function decodeToolCalls(
  raw: unknown,
): Array<{ id: string; name: string; arguments: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ id: string; name: string; arguments: string }> = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const fn =
      typeof obj["function"] === "object" && obj["function"] !== null
        ? (obj["function"] as Record<string, unknown>)
        : {};
    const id = typeof obj["id"] === "string" ? obj["id"] : "";
    const name = typeof fn["name"] === "string" ? fn["name"] : "";
    if (id === "" && name === "") continue;
    out.push({ id, name, arguments: typeof fn["arguments"] === "string" ? fn["arguments"] : "" });
  }
  return out;
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
  const text = typeof m.content === "string" ? m.content : "";
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    /* not JSON: keep the raw text as the value */
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (typeof obj["error"] === "string") return { ok: false, value, error: obj["error"] };
  }
  return { ok: true, value };
}

/**
 * Normalize a per-turn usage payload into a `TokenUsage` (numeric, finite
 * fields only). Returns `undefined` when nothing usable is present so
 * callers can treat the turn as having no usage (never throw).
 */
export function decodeTurnUsage(value: unknown): TokenUsage | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  const out: TokenUsage = {};
  let has = false;
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"] as const) {
    const n = rec[key];
    if (typeof n === "number" && Number.isFinite(n)) {
      out[key] = n;
      has = true;
    }
  }
  return has ? out : undefined;
}

/** The current context weight: the last known absolute total (0 when none). */
export function finalContextTotal(
  turns: ReadonlyArray<{ usage?: TokenUsage } | undefined> | undefined,
): number {
  if (!Array.isArray(turns)) return 0;
  let last = 0;
  for (const t of turns) {
    const n = t?.usage?.total_tokens;
    if (typeof n === "number" && Number.isFinite(n) && n > 0) last = n;
  }
  return last;
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
export function perTurnDeltas(
  turns: ReadonlyArray<{ turnId: number; usage?: TokenUsage; durationMs?: number }> | undefined,
): Map<number, { usage?: TokenUsage; durationMs?: number }> {
  const out = new Map<number, { usage?: TokenUsage; durationMs?: number }>();
  if (!Array.isArray(turns)) return out;
  let prevTotal = 0;
  const ordered = [...turns]
    .filter(
      (t): t is { turnId: number; usage?: TokenUsage; durationMs?: number } =>
        t !== null && typeof t === "object",
    )
    .sort((a, b) => a.turnId - b.turnId);
  for (const t of ordered) {
    if (t === null || typeof t !== "object") continue;
    const turnId = t.turnId;
    if (typeof turnId !== "number" || !Number.isFinite(turnId)) continue;
    const total = t.usage?.total_tokens;
    const entry: { usage?: TokenUsage; durationMs?: number } = {};
    if (typeof t.durationMs === "number" && Number.isFinite(t.durationMs)) {
      entry.durationMs = t.durationMs;
    }
    if (typeof total === "number" && Number.isFinite(total) && total > 0) {
      const delta = total - prevTotal;
      if (delta > 0) entry.usage = { total_tokens: delta };
      prevTotal = total;
    }
    if (entry.usage !== undefined || entry.durationMs !== undefined) out.set(turnId, entry);
  }
  return out;
}

/** Pretty text for a tool result row: `name → <result>`. */
function toolResultText(m: TranscriptMessage): string {
  const name = typeof m.name === "string" && m.name !== "" ? m.name : (m.toolCallId ?? "tool");
  let pretty: string | undefined;
  const content = typeof m.content === "string" ? m.content : undefined;
  if (content !== undefined) {
    try {
      const parsed: unknown = JSON.parse(content);
      if (parsed !== null && typeof parsed === "object") {
        pretty = JSON.stringify(parsed, null, 2);
      }
    } catch {
      /* not JSON — fall through */
    }
  }
  const right = pretty ?? (content !== "" ? content : "(no result)");
  return `${name} → ${right}`;
}

/** Tool-call summary for an assistant row: `tool call: a, b`. */
function toolCallSummary(m: TranscriptMessage): string {
  const names = decodeToolCalls(m.toolCalls)
    .map((c) => c.name || "tool")
    .join(", ");
  return `tool call: ${names === "" ? "tool" : names}`;
}

/**
 * Primary display text for one wire row (derived from every field present).
 * Plain rows use their content verbatim; assistant rows carrying tool calls
 * summarize them (the renderer builds the rich call line from `raw`); tool
 * result rows render as `name → result`.
 */
export function transcriptText(m: TranscriptMessage): string {
  const content = typeof m.content === "string" ? m.content : "";
  if (m.role === "assistant") {
    if (m.toolCalls === undefined) return content;
    const summary = toolCallSummary(m);
    if (content !== "") return `${content} [${summary}]`;
    return summary;
  }
  if (m.role === "tool") return toolResultText(m);
  return content;
}

/**
 * Expand a transcript payload into display entries in seq order — one entry
 * per row, every message kind (user/assistant/system/tool) included.
 * Unknown roles normalize to `system` entries (defensive, never a
 * fallback mode); malformed rows — non-objects or roleless — are skipped
 * without throwing.
 */
export function toTranscriptEntries(messages: TranscriptMessage[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const m of messages) {
    if (m === null || typeof m !== "object" || Array.isArray(m)) continue;
    if (typeof m.role !== "string") continue;
    if (m.role === "user" || m.role === "assistant" || m.role === "tool") {
      entries.push({ role: m.role, text: transcriptText(m), raw: m });
      continue;
    }
    // `system` rows render as system entries; a row with no recognizable
    // role at all is malformed and skipped (defense, never a fallback).
    entries.push({ role: "system", text: transcriptText(m), raw: m });
  }
  return entries;
}
