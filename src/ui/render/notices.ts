/**
 * Notice and status entry rendering: the themed notice line (label,
 * separator, dimmed detail) and the one-line per-turn status summary.
 */
import { ST } from "../theme.ts";
import { truncateAnsi, wrapText } from "../../util/index.ts";
import type { LogEntry } from "../../core/index.ts";
import type { EntryRender } from "./entryRender.ts";

/**
 * Notices and errors render in FULL, as a SINGLE logical line — the label
 * in its themed color (light blue for info, yellow for wait ⚠️, blue-grey
 * for lifecycle 🪧 notices), a mid-dot separator, and the detail dimmed —
 * WORD-WRAPPED so nothing is ever truncated and the block never soft-wraps
 * past the terminal edge. They are never focusable, so collapsing them
 * would hide content forever.
 *
 * The BLOCK shape carries the padding: the composed line is wrapped at
 * cols-2 (leaving room for a 1-cell gutter on each side), and the whole
 * wrapped block is then rendered through ST.noticeBlock — the theme's
 * notice layout primitive — which applies true 1-cell horizontal padding
 * to EVERY row of the block (label, continuation, label-only alike).
 * No component-level padding logic: the style owns the padding, the
 * component only shapes the content (one pre-wrapped line).
 */
export function renderNotice(entry: LogEntry, cols: number): EntryRender {
  const label = entry.lines[0] ?? "";
  const detail = entry.lines[1] ?? "";
  const noticeStyle = label.startsWith("⚠️")
    ? ST.noticeWait
    : label.startsWith("🪧")
      ? ST.noticeSystem
      : ST.notice;
  const line =
    detail === ""
      ? noticeStyle.render(label)
      : `${noticeStyle.render(label)} \x1b[39m· ${ST.noticeDetail.render(detail)}`;
  const rows = wrapText(line, Math.max(1, cols - 2));
  if (rows.length === 0) rows.push("");
  return {
    rendered: ST.noticeBlock.render(rows.join("\n")),
    rows: rows.length,
    tableOffsets: [],
  };
}

/**
 * The per-turn status summary: one line, dark grey text on the normal
 * background with 1-cell horizontal padding, capped to the terminal width
 * (the padding sits inside the style, so the content budget is cols-2).
 */
export function renderStatus(entry: LogEntry, cols: number): EntryRender {
  const line = entry.lines[0] ?? "";
  const budget = Math.max(0, cols - 2);
  return {
    rendered: ST.statusLine.render(truncateAnsi(line, budget)),
    rows: 1,
    tableOffsets: [],
  };
}
