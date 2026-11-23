/**
 * Plain entry rendering: the fallback for kinds without a bespoke renderer
 * (system-kind transcript rows, any future kind).
 */
import { wrapText } from "../../util/index.ts";
import type { Style } from "@oakoliver/lipgloss";
import type { EntryRender } from "./entryRender.ts";
import type { LogEntry } from "../../core/index.ts";

/**
 * Wrap every logical line to the terminal width, then style each wrapped
 * row individually — lipgloss would style the joined string WITHOUT
 * wrapping, leaving one overwide row for the frame to truncate. Styling
 * per row keeps every kind's color on all of its rows (no drift from the
 * kind-level style), and rows.length stays one-terminal-row-per-row.
 */
export function renderPlainEntry(entry: LogEntry, cols: number, style: Style): EntryRender {
  const lines: string[] = [];
  for (const line of entry.lines) lines.push(...wrapText(line, cols));
  if (lines.length === 0) lines.push("");
  const rendered = lines.map((line) => style.render(line)).join("\n");
  return { rendered, rows: lines.length, tableOffsets: [] };
}
