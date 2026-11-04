/**
 * Entry-level formatting helpers: tool-result body rows.
 *
 * Tool bodies render as LOGICAL lines: each source line stays whole, and the
 * terminal soft-wraps overlong ones at the right margin. Collapsed rows and
 * table cells remain width-bounded elsewhere.
 */
import { highlightBlock } from "./markdown.ts";

/** Loose cap on the number of body rows shown for a tool result. */
const CAP = 500;

/** Body rows for a tool-result block (undefined when nothing is worth showing). */
function previewBody(result: unknown): string[] | undefined {
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
          rows.push(line);
        }
      }
      return rows.length > 0 ? rows : undefined;
    }
  }

  const highlighted = highlightBlock(result);
  if (highlighted && highlighted.length > 0) return highlighted;
  const text =
    typeof result === "string" ? result : (JSON.stringify(result, null, 2) ?? String(result));
  if (text.trim() === "") return undefined;
  const plain = text.split("\n");
  if (plain.length > CAP) return plain.slice(0, CAP);
  return plain;
}

/** Body rows for a tool-result block ([] when there is nothing to show). */
export function resultPreview(result: unknown): string[] {
  return previewBody(result) ?? [];
}