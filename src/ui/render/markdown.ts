/**
 * Glamour markdown rendering, shared by prose and table cells.
 *
 * One formatter for both: glamour detects markdown links and bare URLs
 * (OSC 8 included), styles inline markdown, and word-wraps. The
 * normalization here strips glamour's block furniture (document margins,
 * shared indent, padding rows) so the output fits arbitrary widths —
 * full terminal rows for prose, column widths for table cells. Rows are
 * HARD-wrapped: every output line is capped to the requested width, so
 * no line ever exceeds it and the terminal never soft-wraps a chunk.
 */
import {
  newTermRenderer,
  type TermRenderer,
  withStandardStyle,
  withWordWrap,
} from "@oakoliver/glamour";
import { sliceAnsi } from "@oakoliver/lipgloss";
import { GLAMOUR_THEME } from "../theme.ts";
import { displayWidth, matchEscape, stripAnsi, truncateAnsi } from "../../util/ansi.ts";

/** Memoized glamour renderers, keyed by wrap width (max 8 before reuse). */
const mdRenderers = new Map<number, TermRenderer>();

/** Glamour renderer for `cols` (constructed once per width, then reused). */
function mdRenderer(cols: number): TermRenderer {
  const width = Math.max(1, cols);
  const cached = mdRenderers.get(width);
  if (cached) return cached;
  const renderer = newTermRenderer(withStandardStyle(GLAMOUR_THEME), withWordWrap(width));
  if (mdRenderers.size >= 8) mdRenderers.clear(); // simple bound on growth
  mdRenderers.set(width, renderer);
  return renderer;
}

/** Render markdown at `cols` via glamour with tokyo-night styling. Returns ""
 *  on renderer failure so callers can fall back to plain text. */
export function mdRender(text: string, cols: number): string {
  try {
    return mdRenderer(cols).render(text);
  } catch {
    return "";
  }
}

/** Remove up to `n` leading plain spaces, keeping any embedded escapes. */
export function trimLeading(line: string, n: number): string {
  let out = "";
  let i = 0;
  let removed = 0;
  while (i < line.length && removed < n) {
    const ch = line[i] as string;
    if (ch === "\x1b") {
      const esc = matchEscape(line.slice(i));
      if (esc) {
        out += esc;
        i += esc.length;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === " ") {
      removed += 1;
      i += 1;
      continue;
    }
    break; // non-space before the indent is consumed: leave the rest alone
  }
  return out + line.slice(i);
}

/** Drop glamour's blank outer rows from a rendered block. */
export function trimBlankOuter(lines: string[]): string[] {
  while (lines.length > 0 && stripAnsi(lines[0] ?? "").trim() === "") lines.shift();
  while (lines.length > 0 && stripAnsi(lines[lines.length - 1] ?? "").trim() === "") lines.pop();
  return lines;
}

/** Shared leading indent (in cells) across a rendered block's content rows. */
export function sharedIndent(lines: string[]): number {
  const indents: number[] = [];
  for (const line of lines) {
    if (stripAnsi(line).trim() !== "") indents.push(line.match(/^ */)?.[0].length ?? 0);
  }
  return indents.length > 0 ? Math.min(...indents) : 0;
}

/**
 * Render raw text/JSON with glamour syntax highlighting, then normalize it
 * for the terminal: drop glamour's blank outer lines and shared indent,
 * cap every line to `cols`. Returns undefined on failure or oversized input
 * so callers can fall back to plain text.
 */
export function highlightBlock(
  value: unknown,
  cols: number,
  lang: string = "json",
): string[] | undefined {
  try {
    const text =
      typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
    if (text.length > 100_000) return undefined;
    const rendered = mdRender(`\`\`\`${lang}\n${text}\n\`\`\``, cols);
    if (rendered === "") return undefined;
    const lines = trimBlankOuter(rendered.split("\n"));
    if (lines.length === 0) return undefined;
    const indent = sharedIndent(lines);
    const out: string[] = [];
    for (const line of lines) {
      if (stripAnsi(line).trim() === "") continue; // glamour padding rows
      out.push(truncateAnsi(trimLeading(line, indent), cols));
    }
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Render markdown through glamour (tokyo-night) at `cols` and normalize:
 * drop blank outer rows, strip glamour's shared indent, keep interior
 * blank rows (paragraph breaks), and cap every line to `cols`. Returns []
 * on failure or oversized input so callers can fall back to plain text.
 */
export function renderMarkdown(text: string, cols: number): string[] {
  if (text.length > 100_000) return [];
  const rendered = mdRender(text, cols);
  if (rendered === "") return [];
  return hangWrapRows(normalizeLines(rendered, cols, text), cols);
}

/** Shared group normalization: trim glamour's blank outer rows, strip the
 *  block's shared indent, keep interior blank rows (paragraph breaks), and
 *  cap every line to `cols`. Exported for the entry-prose module
 *  (prose.ts), which renders each paragraph group as its own glamour
 *  document and reuses this exact post-processing. */
export function normalizeLines(rendered: string, cols: number, source: string): string[] {
  const lines = trimBlankOuter(rendered.split("\n"));
  if (lines.length === 0) return source.trim() === "" ? [""] : [];
  const indent = sharedIndent(lines);
  const out: string[] = [];
  for (const line of lines) {
    if (stripAnsi(line).trim() === "") {
      out.push(""); // paragraph break inside the group
      continue;
    }
    out.push(truncateAnsi(trimLeading(line, indent), cols));
  }
  return out;
}

/** A list-marker row start: indent + (dash/asterisk/bullet or a 1-9 digit
 *  marker) + one separator space. The BULLET rune (•) is what glamour
 *  emits for unordered items after normalization, not the source "-". */
const LIST_MARK_RE = /^(\s*)(?:[-*+•]|\d{1,9}[.)])( )/;

/**
 * Hanging indent for list rows: glamour wraps an item's continuation
 * rows back to the item's own left edge, so a wrapped bullet reads as
 * several top-level rows. Every row after a marker row is padded to the
 * marker's content column (indent + marker + separator) until the next
 * marker row or blank row. Rows are already normalized text — glamour
 * colors words, not leading whitespace, so the pad itself needs no
 * styling; it is prepended as literal spaces BEFORE the row's own escape
 * sequences and any row pushed past `cols` is capped (its last word fit
 * before the pad, so the cap trims pad, not content — except at
 * pathological 1-cell budgets where the marker itself cannot fit).
 *
 * The continuation row's styling must survive: rebuilding it from
 * `stripAnsi(row)` (as this function once did) dropped every SGR on
 * wrapped rows — italic/bold runs and glamour's fg colors vanished the
 * moment a list item wrapped, in assistant prose and in table cells
 * alike. So the row is trimmed in the ANSI domain instead: leading
 * visible spaces are removed with {@link trimLeading} (escape sequences
 * are kept), trailing visible spaces (glamour's per-row padding) are
 * cut with `sliceAnsi` at the last visible cell, and the hang pad is
 * prepended to the intact styled row.
 */
export function hangWrapRows(rows: string[], cols: number): string[] {
  const out: string[] = [];
  let hang = 0;
  for (const row of rows) {
    const plain = stripAnsi(row).replace(/ +$/, "");
    const lead = (plain.match(/^ */) ?? [""])[0].length;
    const marker = plain.trimStart().match(LIST_MARK_RE);
    if (marker !== null) {
      hang = lead + marker[0].length;
      out.push(row);
      continue;
    }
    if (hang > 0 && plain.trim() !== "") {
      // Trim leading/trailing VISIBLE spaces without touching escapes:
      // trimLeading keeps embedded SGR/OSC runs, sliceAnsi keeps the
      // trailing runs attached past the last visible cell.
      const trimmed = trimLeading(row, Number.MAX_SAFE_INTEGER);
      const contentEnd = displayWidth(stripAnsi(trimmed).replace(/ +$/, ""));
      const styled = contentEnd > 0 ? sliceAnsi(trimmed, 0, contentEnd) : "";
      out.push(truncateAnsi(" ".repeat(hang) + styled, cols));
      continue;
    }
    out.push(row);
    if (plain.trim() === "") hang = 0;
  }
  return out;
}

/**
 * Render ONE logical line of markdown to normalized physical lines.
 *
 * The cell-level counterpart of {@link renderMarkdown}: same glamour
 * pipeline (inline emphasis, OSC 8 links for markdown links and bare
 * URLs, tokyo-night palette), same normalization — minus paragraph-break
 * preservation, which is meaningless for a single line. Returns [] on
 * failure or oversized input so callers can fall back to plain text.
 */
export function renderInlineMarkdown(text: string, cols: number): string[] {
  if (text.length > 100_000) return [];
  if (text === "") return [""]; // blank break-line: hard cap, kept verbatim
  const rendered = mdRenderer(cols).render(text);
  if (rendered === "") return [];
  const lines = trimBlankOuter(rendered.split("\n"));
  if (lines.length === 0) return [];
  const indent = sharedIndent(lines);
  const out: string[] = [];
  for (const line of lines) {
    if (stripAnsi(line).trim() === "") continue;
    const trimmed = trimLeading(line, indent);
    // Glamour pads each rendered line with styled trailing spaces up to the
    // wrap width; cells measure and pad themselves, so cut at the last
    // visible non-space cell (sliceAnsi keeps trailing SGRs attached).
    // The cut point is measured in CELLS, not characters — an emoji is one
    // character but two cells, and a char-count cut shaves a trailing
    // letter off every emoji-bearing line ("✅ Done" → "✅ Don").
    const plain = stripAnsi(trimmed).replace(/\s+$/, "");
    const contentEnd = displayWidth(plain);
    out.push(contentEnd > 0 ? sliceAnsi(trimmed, 0, contentEnd) : "");
  }
  return out;
}
