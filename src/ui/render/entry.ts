/**
 * Entry rendering: glamour markdown, per-kind styling, chunk headers, and
 * the memoized row cache.
 */
import {
  newTermRenderer,
  type TermRenderer,
  withStandardStyle,
  withWordWrap,
} from "@oakoliver/glamour";
import type { Style } from "@oakoliver/lipgloss";
import { GLAMOUR_THEME, ST, CHUNK_HEADER } from "../theme.ts";
import { matchEscape, stripAnsi, truncateAnsi, wrapText } from "../../util/ansi.ts";
import { colorizeToolLine } from "./colorize.ts";
import type { EntryKind, LogEntry } from "./types.ts";

/** Memoized glamour renderers, keyed by wrap width (max 8 before reuse). */
const mdRenderers = new Map<number, TermRenderer>();

/** Glamour renderer for `cols` (constructed once per width, then reused). */
function mdRenderer(cols: number): TermRenderer {
  const width = Math.max(1, cols);
  const cached = mdRenderers.get(width);
  if (cached) return cached;
  const renderer = newTermRenderer(
    withStandardStyle(GLAMOUR_THEME),
    withWordWrap(width),
  );
  if (mdRenderers.size >= 8) mdRenderers.clear(); // simple bound on growth
  mdRenderers.set(width, renderer);
  return renderer;
}

/**
 * Render markdown at `cols` via glamour with tokyo-night styling. Returns ""
 * on renderer failure so callers can fall back to plain text.
 */
function mdRender(text: string, cols: number): string {
  try {
    return mdRenderer(cols).render(text);
  } catch {
    return "";
  }
}

/** Style for an entry kind. */
function kindStyle(kind: EntryKind): Style {
  switch (kind) {
    case "user":
      return ST.user;
    case "assistant":
      return ST.assistant;
    case "tool":
      return ST.tool;
    case "system":
      return ST.system;
    case "error":
      return ST.error;
    case "chunk":
      return ST.chunkBlock;
  }
}

/** Rows a tool-output block body shows before truncation (label excluded). */
const COLLAPSE_LINES = 5;

/** Remove up to `n` leading plain spaces, keeping any embedded escapes. */
function trimLeading(line: string, n: number): string {
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

/**
 * Render text/JSON with glamour syntax highlighting (glamour `mdRender`),
 * then normalize it to the terminal width: drop glamour's blank outer lines
 * and shared indent, cap every line. Returns undefined on failure or
 * oversized input so callers can fall back to plain text.
 */
export function highlightBlock(
  value: unknown,
  cols: number,
  lang: string = "json",
): string[] | undefined {
  try {
    const text =
      typeof value === "string"
        ? value
        : (JSON.stringify(value, null, 2) ?? String(value));
    if (text.length > 100_000) return undefined;
    const rendered = mdRender(`\`\`\`${lang}\n${text}\n\`\`\``, cols);
    if (rendered === "") return undefined;
    const lines = rendered.split("\n");
    while (lines.length > 0 && stripAnsi(lines[0] ?? "").trim() === "") lines.shift();
    while (lines.length > 0 && stripAnsi(lines[lines.length - 1] ?? "").trim() === "") {
      lines.pop();
    }
    if (lines.length === 0) return undefined;
    const indents: number[] = [];
    for (const line of lines) {
      if (stripAnsi(line).trim() !== "") indents.push(line.match(/^ */)?.[0].length ?? 0);
    }
    const indent = indents.length > 0 ? Math.min(...indents) : 0;
    const out: string[] = [];
    for (const line of lines) {
      const plain = stripAnsi(line);
      if (plain.trim() === "") continue; // glamour padding rows
      out.push(truncateAnsi(trimLeading(line, indent), cols));
    }
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Render markdown through glamour (tokyo-night) at `cols` and normalize:
 * drop blank outer rows, strip glamour's shared indent, keep interior blank
 * rows (paragraph breaks), and cap every line to `cols`. Returns [] on
 * failure or oversized input so callers can fall back to plain text.
 */
export function renderMarkdown(text: string, cols: number): string[] {
  if (text.length > 100_000) return [];
  const rendered = mdRender(text, cols);
  if (rendered === "") return [];
  const lines = rendered.split("\n");
  while (lines.length > 0 && stripAnsi(lines[0] ?? "").trim() === "") lines.shift();
  while (lines.length > 0 && stripAnsi(lines[lines.length - 1] ?? "").trim() === "") lines.pop();
  if (lines.length === 0) return [];
  const indents: number[] = [];
  for (const line of lines) {
    if (stripAnsi(line).trim() !== "") indents.push(line.match(/^ */)?.[0].length ?? 0);
  }
  const indent = indents.length > 0 ? Math.min(...indents) : 0;
  const out: string[] = [];
  for (const line of lines) {
    if (stripAnsi(line).trim() === "") {
      out.push(""); // paragraph break inside the entry
      continue;
    }
    out.push(truncateAnsi(trimLeading(line, indent), cols));
  }
  return out;
}

/** A fully styled entry: its rendered rows and their count. */
interface EntryRender {
  rendered: string;
  rows: number;
}

/**
 * Flatten glamour's theme colors out of a rendered markdown row, keeping only
 * structural emphasis (bold/italic): inside the prompt bubble the role style
 * (light-grey text on light-grey bg) must win, and background resets would
 * punch holes in it. Glamour packs attributes into combined SGRs
 * (`38;2;r;g;b;3`) — trailing attributes (3=italic, 1=bold, …) are
 * re-emitted standalone; closing resets become attr-off codes so emphasis
 * never leaks past its run. Assistant replies keep glamour's full styling.
 */
function flattenMarkdown(rows: string[]): string[] {
  return rows.map((row) =>
    row
      .replaceAll("\x1b[m", "\x1b[23m\x1b[22m")
      .replaceAll("\x1b[0m", "\x1b[23m\x1b[22m")
      .replace(
        /\x1b\[(?:38;2;\d{1,3};\d{1,3};\d{1,3}|38;5;\d{1,3}|48;2;\d{1,3};\d{1,3};\d{1,3}|48;5;\d{1,3})((?:;\d+)*)m/g,
        (_m, attrs: string) => {
          const clean = attrs.replace(/^;/, ""); // drop leading ";"
          return clean ? `\x1b[${clean}m` : "";
        },
      ),
  );
}

/**
 * Render one entry to its styled block at `cols`. Prompts and responses go
 * through the glamour markdown renderer first: prompts render in a light-grey
 * padded bubble with theme colors flattened to the bubble's light-grey text
 * (emphasis kept); assistant replies keep full glamour styling on a plain
 * background. Tool-output blocks are always full height (header with exit
 * status + output, black bg, dark-grey text); headers show `↓` when expanded
 * (bodies <= COLLAPSE_LINES are always expanded), `→` when collapsed. Other
 * rows wrap plain.
 */
function renderEntry(entry: LogEntry, cols: number, focused = false): EntryRender {
  if (entry.kind === "user" || entry.kind === "assistant") {
    const isUser = entry.kind === "user";
    const text = entry.lines.join("\n");
    // Prompt: 1-cell padding each side sits INSIDE the style width, so the
    // content wraps at cols-2 while the block spans the full terminal.
    const bodyW = Math.max(1, isUser ? cols - 2 : cols);
    const md = renderMarkdown(text, bodyW);
    const content =
      md.length > 0 ? (isUser ? flattenMarkdown(md) : md) : wrapText(text, bodyW);
    const style = isUser ? ST.user.width(cols) : ST.assistant;
    const rendered = style.render(content.join("\n"));
    return { rendered, rows: rendered.split("\n").length };
  }

  if (entry.kind === "chunk") {
    const body = entry.lines.slice(1);
    const expandable = body.length > COLLAPSE_LINES;
    const open = !entry.collapsed || !expandable; // short blocks are full
    const header = entry.lines[0] ?? "";
    const arrowed = open ? header.replace("→", "↓") : header; // ↓ when expanded
    // Header: bold + underlined; bright green on exit 0, bright red otherwise.
    const exitCode = header.match(/exit (-?\d+)/);
    const headerColor = !exitCode
      ? CHUNK_HEADER.plain
      : Number(exitCode[1]) === 0
        ? CHUNK_HEADER.ok
        : CHUNK_HEADER.fail;
    const styledHeader =
      `\x1b[1m\x1b[4m${headerColor}${arrowed}` + "\x1b[39m\x1b[24m\x1b[22m";
    const style = (focused ? ST.chunkBlockFocus : ST.chunkBlock).width(cols);
    if (open) {
      const rendered = style.render([styledHeader, ...body].join("\n"));
      return { rendered, rows: rendered.split("\n").length };
    }
    const shown = body.slice(0, COLLAPSE_LINES);
    const hidden = body.length - shown.length;
    const rendered = style.render(
      [
        styledHeader,
        ...shown,
        `… +${hidden} line${hidden === 1 ? "" : "s"} (focus, Enter)`,
      ].join("\n"),
    );
    return { rendered, rows: rendered.split("\n").length };
  }

  if (entry.kind === "tool") {
    // Identical geometry in both states (1-cell side padding, full width):
    // focusing only recolors, and expansion persists regardless of focus.
    const rows =
      entry.expanded && entry.full !== undefined
        ? [entry.label ?? entry.lines[0] ?? "", ...wrapText(entry.full, Math.max(1, cols - 2))]
        : wrapText(entry.lines[0] ?? "", Math.max(1, cols - 2));
    const style = (focused ? ST.toolFocus : ST.toolPlain).width(cols);
    const rendered = style.render(rows.join("\n"));
    return { rendered: colorizeToolLine(rendered), rows: rendered.split("\n").length };
  }

  const lines: string[] = [];
  for (const line of entry.lines) lines.push(...wrapText(line, cols));
  if (lines.length === 0) lines.push("");
  const rendered = kindStyle(entry.kind).render(lines.join("\n"));
  return { rendered, rows: lines.length };
}

/**
 * Rendered rows for one entry, memoized on the `LogEntry` object. The key
 * captures everything `renderEntry` derives output from: display width, the
 * focus flag, the expand/collapse toggles, and a content signature (streaming
 * entries mutate `lines`, tool calls get `label`/`lines[0]` amended when the
 * result lands). Entries only ever grow (in place for the same signature), so
 * a matching key means a byte-identical render — safe to reuse.
 */
export function cachedRows(entry: LogEntry, cols: number, focused = false): string[] {
  const lines = entry.lines;
  // O(1) content signature: line count + first/last line lengths cover every
  // mutation this codebase performs (append rows, grow last row, amend label).
  const key = `${cols}|${focused ? 1 : 0}|${entry.collapsed ? 1 : 0}|${
    entry.expanded ? 1 : 0
  }|${lines.length}|${lines[0]?.length ?? 0}|${lines[lines.length - 1]?.length ?? 0}|${
    entry.label ?? ""
  }`;
  const hit = entry.cache;
  if (hit !== undefined && hit.entry === entry && hit.key === key) return hit.rows;
  const rows = renderEntry(entry, cols, focused).rendered.split("\n");
  entry.cache = { entry, key, rows };
  return rows;
}

/** Number of rows the given entries occupy at `cols` (incl. separators). */
export function totalRows(entries: LogEntry[], cols: number): number {
  let rows = 0;
  for (const entry of entries) {
    rows += cachedRows(entry, cols).length + 1;
  }
  return rows;
}