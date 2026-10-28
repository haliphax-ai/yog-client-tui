/**
 * Frame composition: viewport (cached entry rows + scroll), input bar, and
 * status line — `render()` turns plain UI state into one styled frame string.
 */
import { joinHorizontal, joinVertical, Left, Top } from "@oakoliver/lipgloss";
import { ST } from "../theme.ts";
import { displayWidth, truncateAnsi } from "../../util/ansi.ts";
import { cachedRows } from "./entry.ts";
import type { LogEntry, RenderState } from "./types.ts";

/**
 * Build the visible log viewport from cached entry rows: walk cumulative
 * row counts to locate `scrollOffset`, then render only entries that
 * intersect the viewport. Cache misses re-render the whole log (width
 * changes, focus moves), but scrolling over a warm cache never does.
 */
function buildViewport(state: RenderState): string[] {
  const { entries, cols, viewportRows, focusIndex } = state;
  const offset = Math.max(0, state.scrollOffset);
  const visible: string[] = [];
  let base = 0; // first row of entries[i]
  let i = 0;
  const blockLen = (idx: number): number => {
    const entry = entries[idx] as LogEntry;
    return cachedRows(entry, cols, idx === focusIndex).length + 1;
  };
  while (i < entries.length && base + blockLen(i) <= offset) {
    base += blockLen(i);
    i += 1;
  }
  let pos = base; // first row of the entry being appended
  for (; i < entries.length && visible.length < viewportRows; i += 1) {
    const rows = cachedRows(entries[i] as LogEntry, cols, i === focusIndex);
    const from = offset > pos ? Math.min(offset - pos, rows.length) : 0;
    for (let r = from; r < rows.length && visible.length < viewportRows; r += 1) {
      visible.push(truncateAnsi(rows[r] as string, cols));
    }
    pos += rows.length + 1; // rows + separator
    if (pos > offset && visible.length < viewportRows) visible.push("");
  }
  while (visible.length < viewportRows) visible.push("");
  return visible;
}

/** Number of rows the current entries occupy at `cols` (incl. separators). */
export function totalRows(entries: LogEntry[], cols: number): number {
  let rows = 0;
  for (const entry of entries) {
    rows += cachedRows(entry, cols).length + 1;
  }
  return rows;
}

/** Render the input bar: marker + text window with a highlighted cursor. */
function buildInput(state: RenderState): string {
  const marker = state.promptMarker;
  const markerW = displayWidth(marker);
  const avail = Math.max(1, state.cols - markerW);
  const text = state.input;
  const pos = Math.max(0, Math.min(state.cursor, text.length));

  // Ensure the cursor is inside the visible window.
  let scroll = Math.max(0, Math.min(state.inputScroll, Math.max(0, text.length)));
  if (pos < scroll) scroll = pos;
  while (displayWidth(text.slice(scroll, pos)) > avail - 1 && scroll < pos) scroll += 1;
  const win = text.slice(scroll);

  const before = win.slice(0, pos - scroll);
  const at = win.slice(pos - scroll, pos - scroll + 1);
  const after = win.slice(pos - scroll + 1);
  const widthAfter = Math.max(0, avail - displayWidth(before) - 1);

  const parts: string[] = [
    ST.promptMarker.render(marker),
    ST.inputText.render(before),
    at === "" ? ST.cursor.render(" ") : ST.cursor.render(at),
    ST.inputText.render(truncateAnsi(after, widthAfter)),
  ];
  const line = joinHorizontal(Left, ...parts);
  return truncateAnsi(line, state.cols);
}

/** Compose the whole frame: viewport + input bar + status line. */
export function render(state: RenderState): string {
  const rows = Math.max(1, state.viewportRows);
  const viewportLines = buildViewport({ ...state, viewportRows: rows });
  const viewport = viewportLines.join("\n");
  const input = buildInput(state);
  const status = ST.status.render(state.status);
  const frame = joinVertical(Top, viewport, input, status);
  const lines = frame.split("\n").map((line) => padAnsi(line, state.cols));
  return lines.join("\n");
}

/** Pad (or truncate) an ANSI-bearing line to exactly `cols` cells. */
function padAnsi(line: string, cols: number): string {
  const width = displayWidth(line);
  if (width === cols) return line;
  if (width > cols) return truncateAnsi(line, cols);
  return line + " ".repeat(cols - width);
}