/**
 * Tool-call argument and result formatting — pure text, no styling.
 *
 * These live in `core` because the presenter builds the tool-call entry
 * from them: the domain formats its own data, the renderer only draws it.
 *
 * Every width here is measured in terminal CELLS, never characters — an
 * emoji is one character but two cells, and slicing by characters silently
 * corrupts emoji-bearing arguments.
 */
import { displayWidth, truncateAnsi } from "../util/ansi.ts";

/** Uncapped compact args (renderer caps at current width). */
export function compactArgs(value: unknown): string {
  let text: string;
  try {
    if (typeof value === "string") text = value;
    else text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Render tool-call arguments as JSON. `compact` (default): whitespace-
 * collapsed, capped to `max` CELLS with an ellipsis — the inline call line.
 * `pretty`: 2-space indented, uncapped — the expanded view.
 */
export function prettyArgs(
  value: unknown,
  max: number,
  mode: "compact" | "pretty" = "compact",
): string {
  if (mode === "pretty") {
    let text: string;
    try {
      if (typeof value === "string") text = value;
      else text = JSON.stringify(value, undefined, 2) ?? String(value);
    } catch {
      text = String(value);
    }
    return text;
  }
  const clean = compactArgs(value);
  const limit = Math.max(12, max);
  // Cells, not characters: 20 emoji are 40 cells and must not blow past
  // the budget.
  if (displayWidth(clean) <= limit) return clean;
  return `${truncateAnsi(clean, limit - 1)}…`;
}
/**
 * Token-count note for a tool result: `234 tok`, `12.4K tok`. A `+` prefix
 * marks a context delta (real provider numbers); a `~` prefix marks a tokenx
 * estimate. "" when there is nothing to show.
 */
export function tokenCountNote(
  tokens: number | undefined,
  opts: { delta?: boolean; estimated?: boolean } = {},
): string {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) return "";
  const prefix = opts.estimated ? "~" : opts.delta ? "+" : "";
  return `${prefix}${formatTokenTotal(tokens)} tok`;
}

/**
 * Exit/runtime status for a tool result: `exit 0 · 42ms` ("" if none).
 */
export function resultStatus(result: unknown): string {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return "";
  const obj = result as Record<string, unknown>;
  const exit = typeof obj["exitCode"] === "number" ? `exit ${obj["exitCode"]}` : "";
  const runtime = typeof obj["runtimeMs"] === "number" ? ` · ${obj["runtimeMs"]}ms` : "";
  return exit || runtime ? `${exit}${runtime}` : "";
}

/**
 * Whether a tool result uses the bash-style output component (stdout/stderr
 * text fields). Tools without that shape get the generic tool-result
 * component instead — a 🔚 call-style block showing the result payload.
 */
export function isBashShaped(result: unknown): boolean {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return false;
  const obj = result as Record<string, unknown>;
  return typeof obj["stdout"] === "string" || typeof obj["stderr"] === "string";
}

/**
 * Human-readable duration abbreviation for milliseconds:
 * `321ms`, `42s`, `5m21s`, `1h0m0s` — units concatenated from the
 * largest nonzero component down. Sub-second shows ms; sub-minute
 * never shows an irrelevant hour.
 * @param ms Duration in milliseconds
 * @param ceilSeconds When true, ceiling-round to whole seconds (useful for backoff waits).
 */
export function formatDuration(ms: number, ceilSeconds = false): string {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  const totalMs = Math.round(ms);
  if (!ceilSeconds && totalMs < 1000) return `${totalMs}ms`;
  const seconds = ceilSeconds ? Math.ceil(ms / 1000) : Math.floor(totalMs / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  let out = "";
  if (hours > 0) out += `${hours}h`;
  if (hours > 0 || minutes > 0) out += `${minutes}m`;
  if (hours > 0 || minutes > 0 || secs > 0) out += `${secs}s`;
  return out || (ceilSeconds ? `${seconds}s` : `${totalMs}ms`);
}

/**
 * Human-readable runtime abbreviation for a duration in milliseconds:
 * `321ms`, `42s`, `5m21s`, `1h0m0s` — units concatenated from the
 * largest nonzero component down, so a sub-minute duration never shows an
 * irrelevant hour.
 * Uses floor rounding for seconds.
 */
export function formatRuntime(durationMs: number): string {
  return formatDuration(durationMs, false);
}

/**
 * Abbreviate a token total (K/M with one decimal) — the shared formatter
 * for the session status-bar stat and the per-turn summary line.
 */
export function formatTokenTotal(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0";
  if (value < 1000) return String(Math.round(value));
  const suffixes = ["", "K", "M"];
  let idx = 0;
  let scaled = value;
  while (scaled >= 1000 && idx < suffixes.length - 1) {
    scaled /= 1000;
    idx += 1;
  }
  // Rounding to one decimal may push a value onto the next order (e.g. 999.95
  // → 1000.0K); promote it so the display stays tidy (1.0M).
  if (scaled >= 999.95 && idx < suffixes.length - 1) {
    return `1.0${suffixes[idx + 1]}`;
  }
  return `${(Math.round(scaled * 10) / 10).toFixed(1)}${suffixes[idx]}`;
}
