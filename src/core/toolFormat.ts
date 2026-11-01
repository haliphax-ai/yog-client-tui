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
  let text: string;
  try {
    if (typeof value === "string") text = value;
    else
      text = JSON.stringify(value, undefined, mode === "pretty" ? 2 : undefined) ?? String(value);
  } catch {
    text = String(value);
  }
  if (mode === "pretty") return text;
  const clean = text.replace(/\s+/g, " ").trim();
  const limit = Math.max(12, max);
  // Cells, not characters: 20 emoji are 40 cells and must not blow past
  // the budget.
  if (displayWidth(clean) <= limit) return clean;
  return `${truncateAnsi(clean, limit - 1)}…`;
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
