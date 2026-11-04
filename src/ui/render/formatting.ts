/**
 * Entry-level formatting helpers: tool-result body rows.
 *
 * The tool-call argument formatting lives in `core/toolFormat.ts` — the
 * presenter builds the call line from it, and the domain must not depend
 * on the presentation layer.
 *
 * Tool bodies render as HARD-wrapped rows: each source line is word-wrapped
 * (and JSON highlighted) to the block's body width, so no row exceeds its
 * budget and the terminal never soft-wraps a chunk.
 */
import { highlightBlock } from "./markdown.ts";
import { wrapText } from "../../util/ansi.ts";

/** Loose cap on the number of body rows shown for a tool result. */
const CAP = 500;

/**
 * Body rows for a tool-result block. The bash tool's shape (stdout/stderr)
 * is rendered as real text — never the JSON-escaped blob; anything else is
 * syntax-highlighted JSON, falling back to plain wrapped lines. Returns
 * undefined when there is nothing worth showing (the exit status then lives
 * in the block header alone).
 */
function previewBody(result: unknown, cols: number): string[] | undefined {
  const target = Math.max(1, cols - 2);

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
    typeof result === "string" ? result : (JSON.stringify(result, null, 2) ?? String(result));
  if (text.trim() === "") return undefined;
  const plain = text.split("\n");
  if (plain.length > CAP) return plain.slice(0, CAP).flatMap((line) => wrapText(line, target));
  return plain.flatMap((line) => wrapText(line, target));
}

/** Body rows for a tool-result block ([] when there is nothing to show). */
export function resultPreview(result: unknown, cols: number): string[] {
  return previewBody(result, cols) ?? [];
}
