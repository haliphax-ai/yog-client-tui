/**
 * Wire payload decoders for the transport: `tool.call.args` and the
 * `usage` object. Tolerant by contract — malformed payloads never throw,
 * they degrade to their raw/undefined form so the UI can decide.
 */
import type { TokenUsage } from "./wire.ts";
/**
 * Decode `tool.call.args`: the wire carries it as a raw JSON string, so
 * parse it into a value the UI can render properly (a string that parses to
 * an object/array is unwrapped; anything else passes through as the original
 * string so the UI can pretty-print or show it verbatim).
 */
export function parseToolArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") return parsed;
    return raw; // scalar JSON: keep the original text for display
  } catch {
    return raw; // not JSON: show the raw string
  }
}

/**
 * Extract a `TokenUsage` from a `turn.finished` payload field, tolerating
 * absent/malformed values: only numeric (finite) fields are copied, and the
 * result is `undefined` when none of them are present — callers then treat
 * the turn as having no usage (never throw).
 */
export function parseUsage(value: unknown): TokenUsage | undefined {
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
