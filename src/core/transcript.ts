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
import type { TranscriptMessage } from "../yogClient.ts";

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
    const fn = typeof obj["function"] === "object" && obj["function"] !== null
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
