/**
 * Cheap exact heights for entries whose render is a single wrapped line.
 */
import { wrapText } from "../../util/index.ts";
import type { LogEntry } from "../../core/index.ts";

/**
 * Cheap exact height for entries whose render is a single wrapped line:
 * placeholders (one truncated label), status lines, and plain system rows
 * cost O(1) wrap work instead of a glamour pass. Returns -1 when the
 * entry needs the real renderer (prose, tables, chunks, tool blocks).
 * Used to seed a placeholder-first log and to estimate unfilled spans.
 */
export function cheapHeight(entry: LogEntry, cols: number): number {
  if (entry.kind === "placeholder" || entry.kind === "status") return 1 + 1; // row + separator
  if (entry.kind === "system") {
    // System rows wrap plain (the fallback renderer): pure wrapText, no
    // glamour — a cheap exact height, not an estimate.
    return wrapText(entry.lines.join("\n"), Math.max(1, cols)).length + 1;
  }
  return -1;
}

/** Cheap per-entry estimate for an unfilled span: one row + separator. */
export function estimateHeight(_entry: LogEntry, _cols: number): number {
  return 2;
}
