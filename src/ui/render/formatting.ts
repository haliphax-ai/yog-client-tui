/**
 * Entry-level formatting helpers: tool-call argument rendering and tool
 * result status/preview.
 */
import { highlightBlock } from "./entry.ts";
import { wrapText } from "../../util/ansi.ts";

/**
 * Render tool-call arguments as JSON. `compact` (default): whitespace-
 * collapsed, capped to `max` cells with an ellipsis — the inline call line.
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
    else text = JSON.stringify(value, undefined, mode === "pretty" ? 2 : undefined) ?? String(value);
  } catch {
    text = String(value);
  }
  if (mode === "pretty") return text;
  const clean = text.replace(/\s+/g, " ").trim();
  const limit = Math.max(12, max);
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

/**
 * Body rows for a tool-result block. The bash tool's shape (stdout/stderr)
 * is rendered as real text — never the JSON-escaped blob; anything else is
 * syntax-highlighted JSON, falling back to plain wrapped lines. Returns
 * undefined when there is nothing worth showing (the exit status then lives
 * in the block header alone).
 */
function previewBody(result: unknown, cols: number): string[] | undefined {
  const target = Math.max(1, cols - 2);
  const CAP = 500;

  // bash-shaped result: stdout/stderr as text (exit status is in the header).
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>;
    const out = obj["stdout"];
    const err = obj["stderr"];
    if (typeof out === "string" || typeof err === "string") {
      const rows: string[] = [];
      for (const chunk of [out, err]) {
        if (typeof chunk !== "string" || chunk.trim() === "") continue;
        const body = chunk.replace(/\n$/, "").split("\n");
        for (const line of body) {
          if (rows.length >= CAP) break;
          rows.push(...wrapText(line, target));
        }
      }
      return rows.length > 0 ? rows : undefined;
    }
  }

  const highlighted = highlightBlock(result, target);
  if (highlighted && highlighted.length > 0) return highlighted;
  const text =
    typeof result === "string"
      ? result
      : (JSON.stringify(result, null, 2) ?? String(result));
  if (text.trim() === "") return undefined;
  const plain = text.split("\n");
  if (plain.length > CAP) return plain.slice(0, CAP).flatMap((line) => wrapText(line, target));
  return plain.flatMap((line) => wrapText(line, target));
}

/** Exit/runtime status for a tool result: `exit 0 · 42ms` ("" if none). */
export function resultStatus(result: unknown): string {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return "";
  const obj = result as Record<string, unknown>;
  const exit = typeof obj["exitCode"] === "number" ? `exit ${obj["exitCode"]}` : "";
  const runtime = typeof obj["runtimeMs"] === "number" ? ` · ${obj["runtimeMs"]}ms` : "";
  return exit || runtime ? `${exit}${runtime}` : "";
}

/** Body rows for a tool-result block ([] when there is nothing to show). */
export function resultPreview(result: unknown, cols: number): string[] {
  return previewBody(result, cols) ?? [];
}