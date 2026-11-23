/**
 * Glamour markdown rendering, shared by prose and table cells.
 *
 * One formatter for both: glamour detects markdown links and bare URLs
 * (OSC 8 included), styles inline markdown, and word-wraps. Renderers
 * are memoized per wrap width. The block furniture glamour adds (margins,
 * shared indent, padding rows) is stripped by `normalize.ts`, the list
 * hang by `listRows.ts`. Rows are HARD-wrapped: every output line is
 * capped to the requested width, so the terminal never soft-wraps.
 *
 * Pipelines here:
 * - `renderMarkdown` — a whole document to normalized rows (prose).
 * - `highlightBlock` — syntax-highlighted code/JSON to capped rows.
 * - `renderInlineMarkdown` — one logical line to rows (table cells).
 */
import {
  newTermRenderer,
  type TermRenderer,
  withStandardStyle,
  withWordWrap,
} from "@oakoliver/glamour";
import { GLAMOUR_THEME } from "../theme.ts";
import { sliceAnsi } from "@oakoliver/lipgloss";
import { displayWidth, stripAnsi, truncateAnsi } from "../../util/index.ts";
import { normalizeLines, sharedIndent, trimBlankOuter, trimLeading } from "./normalize.ts";
import { hangWrapRows } from "./listRows.ts";

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

/**
 * Render ONE logical line of markdown to normalized physical lines.
 *
 * The cell-level counterpart of `renderMarkdown`: same glamour
 * pipeline (inline emphasis, OSC 8 links for markdown links and bare
 * URLs, tokyo-night palette), same normalization — minus paragraph-break
 * preservation, which is meaningless for a single line. Returns [] on
 * failure or oversized input so callers can fall back to plain text.
 */
export function renderInlineMarkdown(text: string, cols: number): string[] {
  if (text.length > 100_000) return [];
  if (text === "") return [""]; // blank break-line: hard cap, kept verbatim
  const rendered = mdRender(text, cols);
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
