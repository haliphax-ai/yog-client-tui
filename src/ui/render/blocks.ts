/**
 * Chunk and tool-block rendering: the collapsible tool-output chunks
 * (debug chunks included) and the tool call/result blocks.
 */
import { CHUNK_HEADER } from "../theme.ts";
import { displayWidth, truncateAnsi, wrapText } from "../../util/ansi.ts";
import { colorizeToolLine } from "./colorize.ts";
import { resultPreview } from "./resultPreview.ts";
import { chunkBlockStyle, toolBlockStyle } from "./entryStyle.ts";
import type { EntryRender } from "./entryRender.ts";
import type { LogEntry } from "../../core/entries.ts";

/** Rows a tool-output block body shows before truncation (label excluded). */
const COLLAPSE_LINES = 5;

/**
 * Render a collapsible block (tool-output chunks, debug chunks). The body
 * comes from the raw result when the entry carries one (the presenter stores
 * the data; the renderer formats it), else from the pre-rendered body lines.
 * Headers show `↓` when expanded (bodies <= COLLAPSE_LINES are always
 * expanded), `→` when collapsed.
 */
export function renderChunkLike(entry: LogEntry, cols: number, focusedTable: boolean): EntryRender {
  const body =
    entry.result !== undefined ? resultPreview(entry.result, cols) : entry.lines.slice(1);
  const expandable = body.length > COLLAPSE_LINES;
  const open = !entry.collapsed || !expandable; // short blocks are full
  const header = entry.lines[0] ?? "";
  const style = chunkBlockStyle(focusedTable).width(cols);
  const rendered = style.render(
    [chunkHeaderOf(header, open), ...visibleBody(body, open)].join("\n"),
  );
  return { rendered, rows: rendered.split("\n").length, tableOffsets: [] };
}

/** The styled chunk header: bold + underlined; bright green on exit 0,
 *  bright red otherwise; `↓` when expanded, `→` when collapsed. */
function chunkHeaderOf(header: string, open: boolean): string {
  const arrowed = open ? header.replace("→", "↓") : header;
  const exitCode = header.match(/exit (-?\d+)/);
  const headerColor = !exitCode
    ? CHUNK_HEADER.plain
    : Number(exitCode[1]) === 0
      ? CHUNK_HEADER.ok
      : CHUNK_HEADER.fail;
  return `\x1b[1m\x1b[4m${headerColor}${arrowed}` + "\x1b[39m\x1b[24m\x1b[22m";
}

/** The body rows a chunk shows: the whole body when open, the first
 *  COLLAPSE_LINES rows plus a `… +N lines` marker when collapsed. */
function visibleBody(body: string[], open: boolean): string[] {
  if (open) return body;
  const shown = body.slice(0, COLLAPSE_LINES);
  const hidden = body.length - shown.length;
  return [...shown, `… +${hidden} line${hidden === 1 ? "" : "s"}`];
}

/**
 * Render a tool call/result block. Identical geometry in both states
 * (1-cell side padding, full width): focusing only recolors, and expansion
 * persists regardless of focus.
 *
 * Expanded: the label plus the full body, hard-wrapped at the body width.
 * Collapsed: the summary line cell-capped to the body width — a long
 * tool-error line must never wrap (a wrapped JSON blob reads as several
 * entries). When truncated, drop one more cell and append a UTF-8 ellipsis
 * so the marker fits within the same budget.
 */
export function renderToolBlock(entry: LogEntry, cols: number, focusedTable: boolean): EntryRender {
  const rows =
    entry.expanded && entry.full !== undefined
      ? expandedRows(entry, cols)
      : collapsedRows(entry, cols);
  const style = toolBlockStyle(focusedTable).width(cols);
  const rendered = style.render(rows.join("\n"));
  return {
    rendered: colorizeToolLine(rendered),
    rows: rendered.split("\n").length,
    tableOffsets: [],
  };
}

/** Expanded rows: the label (or the first line) then the wrapped full body. */
function expandedRows(entry: LogEntry, cols: number): string[] {
  return [
    entry.label ?? entry.lines[0] ?? "",
    ...wrapText(entry.full as string, Math.max(1, cols - 2)),
  ];
}

/** Collapsed rows: the summary line with the token note riding at the end;
 *  the cap shrinks by the note's width so both always fit the budget. */
function collapsedRows(entry: LogEntry, cols: number): string[] {
  const line = summaryLineOf(entry);
  const note = entry.tokenNote === undefined ? "" : ` · ${entry.tokenNote}`;
  const cap = Math.max(1, cols - 2 - displayWidth(note));
  if (displayWidth(line) <= cap) return note === "" ? [line] : [`${line}${note}`];
  return cap > 1 ? [`${truncateAnsi(line, cap - 1)}…${note}`] : [`…${note}`];
}

/** The collapsed summary line: label + compact args when present, else the
 *  entry's first line. */
function summaryLineOf(entry: LogEntry): string {
  if (entry.label === undefined || entry.argsCompact === undefined) {
    return entry.lines[0] ?? "";
  }
  return entry.argsCompact === "" ? entry.label : `${entry.label} ${entry.argsCompact}`;
}
