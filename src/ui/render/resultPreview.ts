/**
 * Tool-result body rows: what a result block shows below its header.
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
import { wrapText } from "../../util/index.ts";

/** Loose cap on the number of body rows shown for a tool result. */
const CAP = 500;

/** The result payload as an object (arrays and primitives decline). */
function resultObject(result: unknown): Record<string, unknown> | undefined {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return undefined;
  return result as Record<string, unknown>;
}

/** The object's stdout/stderr text chunks (whatever their contents). */
function textChunks(obj: Record<string, unknown>): unknown[] {
  return [obj["stdout"], obj["stderr"]];
}

/** True when the payload is bash-shaped: a stdout/stderr text field exists. */
function isBashShaped(obj: Record<string, unknown>): boolean {
  return textChunks(obj).some((chunk) => typeof chunk === "string");
}

/**
 * Wrap the bash tool's stdout/stderr chunks into body rows, capped at
 * {@link CAP} rows. Blank chunks contribute nothing; a payload whose
 * chunks are all blank wraps to no rows at all (the exit status then
 * lives in the block header alone).
 */
function bashBodyRows(obj: Record<string, unknown>, target: number): string[] {
  const rows: string[] = [];
  for (const chunk of textChunks(obj)) {
    if (typeof chunk !== "string" || chunk.trim() === "") continue;
    const body = chunk.replace(/\n$/, "").split("\n");
    for (const line of body) {
      if (rows.length >= CAP) break;
      rows.push(...wrapText(line, target));
    }
  }
  return rows;
}

/**
 * The fallback body: syntax-highlighted JSON when the highlighter accepts
 * the payload, else the plain text rendering, hard-wrapped and capped.
 */
function genericBodyRows(result: unknown, target: number): string[] | undefined {
  const highlighted = highlightBlock(result, target);
  if (highlighted !== undefined && highlighted.length > 0) return highlighted;
  const text =
    typeof result === "string" ? result : (JSON.stringify(result, null, 2) ?? String(result));
  if (text.trim() === "") return undefined;
  return text
    .split("\n")
    .slice(0, CAP)
    .flatMap((line) => wrapText(line, target));
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
  const obj = resultObject(result);
  // A bash-shaped payload (a stdout/stderr text field is present) owns the
  // whole body: its text rows, or nothing when both chunks are blank — the
  // exit status then lives in the block header alone, and the blank chunks
  // must never resurface as the JSON-escaped blob. Any other object shape
  // falls through to the highlighted-JSON body.
  if (obj === undefined || !isBashShaped(obj)) return genericBodyRows(result, target);
  const rows = bashBodyRows(obj, target);
  return rows.length > 0 ? rows : undefined;
}

/** Body rows for a tool-result block ([] when there is nothing to show). */
export function resultPreview(result: unknown, cols: number): string[] {
  return previewBody(result, cols) ?? [];
}
