/**
 * Markdown pipe-table parser: split raw text into prose and table
 * sections, and parse a GFM pipe table out of a block of lines.
 *
 * Pure functions at LINE granularity; no rendering, no caching — the
 * caller caches the result. The cell-level concerns (row splitting,
 * display breaks, rendered-width measurement) live in `cells.ts`.
 */
import { cellWidth, splitCells } from "./cells.ts";

/** One column: its header text, computed width (in cells), and alignment. */
export interface ParsedColumn {
  title: string;
  width: number;
  align: "left" | "center" | "right";
}

/** A parsed table: columns + rows. Rows are rectangular — every row
 *  holds exactly `columns.length` cells (GFM normalization). */
export interface ParsedTable {
  columns: ParsedColumn[];
  rows: string[][];
}

/**
 * A section of split text: either prose or a parsed table.
 *
 * Produced by {@link splitTableSections}; consumed by the entry renderer to
 * route prose through glamour and tables through the table renderer. The
 * focus ring is built from the same list, so a table that renders is always
 * a table that can be focused.
 */
export type TableSection = { kind: "prose"; text: string } | { kind: "table"; table: ParsedTable };
/**
 * A paragraph group within one prose section: the lines are joined and
 * rendered (and normalized) TOGETHER, so glamour sees the same document
 * structure a standard markdown renderer would.
 */
export interface ParagraphGroup {
  lines: string[];
}

/**
 * Split one table row into cells.
 *
 * Handles:
 * - Optional leading/trailing `|` (GFM allows omitting them)
 * - Escaped pipes `\|` (literal pipe inside a cell)
 * - Whitespace trimming around each cell
 * - `<br>` / `<br/>` / `<br />` → display break (rendered as separate lines)
 */
/** True if the line looks like a table row (has pipes and at least one non-empty cell). */
function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "" || !trimmed.includes("|")) return false;
  const cells = splitCells(trimmed);
  return cells.some((c) => c !== "");
}

/** Parse one delimiter cell into an alignment token. */
function parseAlign(cell: string): "left" | "center" | "right" {
  const c = cell.trim();
  if (c.startsWith(":")) return c.endsWith(":") ? "center" : "left";
  return c.endsWith(":") ? "right" : "left";
}

/** True when every cell of the row is `---`-style (a delimiter row). */
function isDelimiterRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

/** True if the line is a table delimiter row (every cell is `---`-style). */
function isTableDelimiter(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes("|") && isDelimiterRow(splitCells(trimmed));
}

/** The table's structural rows: header cells, the delimiter's cells, and
 *  the data rows that follow it. */
interface TableRows {
  header: string[];
  delim: string[];
  data: string[][];
}

/** Find the table's header line: the first line that looks like a table
 *  row (followed by the delimiter). -1 when there is no table start. */
function headerIndexOf(lines: string[]): number {
  return lines.findIndex((line) => isTableRow(line));
}

/** The table's structural rows from `lines`, or undefined when the text
 *  does not open with a valid table (header row + delimiter row). Data
 *  rows are optional — a table with only a header is still valid. */
function tableRowsOf(lines: string[]): TableRows | undefined {
  const headerIdx = headerIndexOf(lines);
  if (headerIdx === -1) return undefined;

  // Next line must be the delimiter
  const delimIdx = headerIdx + 1;
  if (!isRowAt(lines, delimIdx) || !isTableDelimiter(lineAt(lines, delimIdx))) return undefined;
  const delimCells = splitCells(lineAt(lines, delimIdx));

  // GFM: the delimiter row (NOT the header row) fixes the column count, and
  // it must have at least one cell; rows may diverge mid-stream (a streamed
  // cell carrying an unescaped pipe, or the model re-aligning), so every row
  // is normalized below instead of being trusted.
  if (delimCells.length === 0) return undefined;
  const colCount = delimCells.length;
  const header = padTo(splitCells(lineAt(lines, headerIdx)).slice(0, colCount), colCount);
  return { header, delim: delimCells, data: dataRowsOf(lines, delimIdx) };
}

/** The consecutive table rows after the delimiter; the table ends at the
 *  first non-row line. */
function dataRowsOf(lines: string[], delimIdx: number): string[][] {
  const rows: string[][] = [];
  for (const line of lines.slice(delimIdx + 1)) {
    if (!isTableRow(line)) break;
    rows.push(splitCells(line));
  }
  return rows;
}

/** Pad a cell list with empty cells up to `count` (GFM normalization). */
function padTo(cells: string[], count: number): string[] {
  const padded = [...cells];
  while (padded.length < count) padded.push("");
  return padded;
}

/** GFM: rows with fewer cells gain empty trailing cells; rows with more
 *  cells have the excess dropped. Streamed text routinely produces ragged
 *  tables (an unescaped pipe mid-cell, or a row that arrives wider than the
 *  header) — a row longer than colCount used to crash the renderer when it
 *  indexed header-derived per-column state (widths, alignments). */
function normalizeRows(rows: string[][], colCount: number): string[][] {
  return rows.map((row) => padTo(row.slice(0, colCount), colCount));
}

/** The width of one column: the widest of the header and every data row's
 *  cell. Multi-line cells (from <br>) count their widest sub-line, not
 *  total length. */
function columnWidth(header: string | undefined, rows: string[][], c: number): number {
  const cells = [header ?? "", ...rows.map((row) => row[c] ?? "")];
  return Math.max(...cells.map((cell) => cellWidth(cell)));
}

/** Per-column widths from the header plus every data cell. */
function columnWidths(header: string[], rows: string[][], colCount: number): number[] {
  return Array.from({ length: colCount }, (_, c) => columnWidth(header[c], rows, c));
}

/**
 * Parse a GFM pipe table from `text`.
 *
 * Returns `null` when the text doesn't start with a valid table
 * (header row + delimiter row). Data rows are optional — a table
 * with only a header is still valid.
 *
 * Per GFM, the delimiter row fixes the column count; ragged rows are
 * normalized to it (short rows gain empty cells, excess cells are
 * dropped), so `rows` is always rectangular and every row's cell
 * count equals `columns.length`.
 *
 * The text may contain leading/trailing blank lines; they're skipped.
 * Parsing stops at the first non-table line after the delimiter.
 */
export function parseTable(text: string): ParsedTable | null {
  const rows = tableRowsOf(text.split("\n"));
  if (rows === undefined) return null;
  const colCount = rows.delim.length;
  const normalized = normalizeRows(rows.data, colCount);
  const widths = columnWidths(rows.header, normalized, colCount);
  // Per-column alignment from the delimiter's own cells — every column has
  // one (delimCells.length IS colCount), so the align lookup cannot miss.
  const aligns = rows.delim.map((c) => parseAlign(c));
  return {
    columns: rows.header.map((title, i) => ({
      title,
      width: widths[i]!,
      align: aligns[i] ?? "left",
    })),
    rows: normalized,
  };
}

/**
 * Fenced-code-block scanning, shared by the section splitter and the
 * paragraph grouper — both must agree on where a fence begins and ends,
 * because fence content is LITERAL: no tables, no paragraph breaks, no
 * list markers may be read out of it (issue #108).
 */

/** The ```/~~~ run that opens a fence on this line (≤3 spaces of indent,
 *  per CommonMark). The sigil is the full run — its character and length
 *  are what the closer must match. */
function fenceOpener(line: string): string | undefined {
  return line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
}

/** The bare run on a line that could close a fence (empty when the line
 *  carries anything else — no info string on a closing fence). */
function closingRun(line: string): string {
  return line.match(/^ {0,3}(`{3,}|~{3,})\s*$/)?.[1] ?? "";
}

/** True when the line closes a fence opened with sigil `opener`: a bare
 *  run of the same character at least as long, nothing else on the line. */
function closesFence(line: string, opener: string): boolean {
  const run = closingRun(line);
  return run.length >= opener.length && run.startsWith(opener[0] ?? "\u0000");
}

/**
 * Split raw markdown text into alternating prose and table sections.
 *
 * A table starts when a line looks like a table row AND the next line
 * is a delimiter. It ends at the first non-table-row line after the
 * delimiter. Everything else is prose. Leading/trailing blank lines
 * on each prose section are trimmed; interior blank lines (paragraph
 * breaks) are preserved.
 *
 * Returns a flat list — adjacent sections are never of the same kind.
 *
 * This is the SINGLE source of truth about which parts of an entry are
 * tables: the renderer draws the table sections, the focus ring walks the
 * same sections, and the scroll bounds measure the same sections. They
 * cannot disagree.
 */
/** True when a table starts at `lines[i]`: the line is a table row AND the
 *  next line is a delimiter. */
function tableStartsAt(lines: string[], i: number): boolean {
  return isRowAt(lines, i) && isRowAt(lines, i + 1) && isTableDelimiter(lineAt(lines, i + 1));
}

/** The line at `i` ("" past the end). */
function lineAt(lines: string[], i: number): string {
  return lines[i] ?? "";
}

/** True when the line at `i` looks like a table row (past the end: no). */
function isRowAt(lines: string[], i: number): boolean {
  return i < lines.length && isTableRow(lineAt(lines, i));
}

/** The run of consecutive table-row lines at `i` (the start row and every
 *  table row after it). */
function tableRunAt(lines: string[], i: number): string[] {
  const run: string[] = [];
  let j = i;
  while (isRowAt(lines, j)) {
    run.push(lineAt(lines, j));
    j += 1;
  }
  return run;
}

/** The section walk's mutable state: the prose buffer, the open fence's
 *  sigil, and the finished sections. Fence content stays prose — a pipe
 *  row inside a fence is literal text, not a table. */
interface SectionState {
  sections: TableSection[];
  proseLines: string[];
  fence: string | undefined;
}

/** Flush the prose buffer as one section (blank buffers flush to nothing). */
function flushProse(st: SectionState): void {
  const body = st.proseLines.join("\n").trim();
  if (body.length > 0) st.sections.push({ kind: "prose", text: body });
  st.proseLines = [];
}

/** One fence-content line: literal prose; the closer ends the fence. */
function pushFenceContent(st: SectionState, line: string): void {
  st.proseLines.push(line);
  if (closesFence(line, st.fence as string)) st.fence = undefined;
}

/** A table run at `i`: the parsed table section, or the raw lines back as
 *  prose when parseTable rejects the run (it is not always a table). */
function pushTableRun(st: SectionState, lines: string[], i: number): number {
  flushProse(st);
  const tableLines = tableRunAt(lines, i);
  const parsed = parseTable(tableLines.join("\n"));
  if (parsed) st.sections.push({ kind: "table", table: parsed });
  else st.proseLines.push(...tableLines); // parseTable failed — prose
  return tableLines.length;
}

/** The line kinds the splitter distinguishes, in priority order: fence
 *  content (literal), a fence opener, a table run, or plain prose. */
function consumeLine(st: SectionState, lines: string[], i: number): number {
  const line = lineAt(lines, i);
  // Fence content is literal — scan for the closer, never for tables.
  if (st.fence !== undefined) {
    pushFenceContent(st, line);
    return 1;
  }
  const open = fenceOpener(line);
  if (open !== undefined) {
    st.fence = open;
    st.proseLines.push(line);
    return 1;
  }
  // A table starts here: this line is a table row AND the next is a delimiter.
  if (tableStartsAt(lines, i)) return pushTableRun(st, lines, i);
  st.proseLines.push(line);
  return 1;
}

export function splitTableSections(text: string): TableSection[] {
  const lines = text.split("\n");
  const st: SectionState = { sections: [], proseLines: [], fence: undefined };
  for (let i = 0; i < lines.length;) {
    i += consumeLine(st, lines, i);
  }
  flushProse(st);
  return st.sections;
}

/** The list-marker geometry of one line: the marker's indent (cells before
 *  it) and width (indent + marker + one separator space). */
interface ListMarker {
  indent: number;
  width: number;
}

const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])(\s)/;

function markerOf(line: string): ListMarker | undefined {
  const m = line.match(LIST_RE);
  if (m === null) return undefined;
  const indent = (m[1] ?? "").length;
  return { indent, width: indent + (m[2] ?? "").length + 1 };
}

/** The shallowest open list level (Infinity when the stack is empty). */
function shallowestIndent(stack: ListMarker[]): number {
  return stack[0]?.indent ?? Infinity;
}

/** The deepest open item's marker content width (0 when none is open). */
function deepestWidth(stack: ListMarker[]): number {
  return stack[stack.length - 1]?.width ?? 0;
}

/** True when `line` (with its marker, if any) continues the open list and
 *  must stay in the current group: a marker at or below the SHALLOWEST open
 *  level (the next sibling of any open list — a deeper marker nests, a
 *  shallower one closes back down), or a plain continuation row indented to
 *  the deepest open item's marker content (a soft-wrapped row of that item). */
function continuesOpenList(line: string, mk: ListMarker | undefined, stack: ListMarker[]): boolean {
  if (stack.length === 0) return false;
  if (mk !== undefined) return mk.indent >= shallowestIndent(stack);
  return (line.match(/^ */) ?? [""])[0].length >= deepestWidth(stack);
}

/** The open-list nesting after `line` joins the current group: markers at or
 *  below the new marker's indent pop (their lists closed), the marker itself
 *  pushes (deepest last). Lines without a marker leave the stack alone. */
function nestingAfter(stack: ListMarker[], mk: ListMarker | undefined): ListMarker[] {
  if (mk === undefined) return stack;
  const next = stack.filter((open) => open.indent < mk.indent);
  next.push(mk);
  return next;
}

/** The grouping walk's mutable state: the group under construction, the
 *  blank-line pending between groups, the open list nesting, and the
 *  fence/after-fence state. */
interface GroupState {
  groups: ParagraphGroup[];
  current: string[];
  pendingBreak: boolean;
  stack: ListMarker[];
  fence: string | undefined;
  afterFence: boolean;
}

/** Fence content inside one group: the line is literal (blank lines
 *  INCLUDED, issue #108); the closer ends the fence, and whatever comes
 *  after opens a fresh group. */
function pushFenceLine(st: GroupState, line: string): void {
  st.current.push(line);
  if (closesFence(line, st.fence as string)) {
    st.fence = undefined;
    st.afterFence = true;
  }
  st.pendingBreak = false;
}

/** A blank line: the mark of a possible paragraph break. */
function pushBlankLine(st: GroupState): void {
  st.pendingBreak = st.current.length > 0;
}

/** Close the group under construction (no-op when it is empty). */
function closeGroup(st: GroupState): void {
  if (st.current.length > 0) {
    st.groups.push({ lines: st.current });
    st.current = [];
    st.stack = [];
  }
  st.pendingBreak = false;
}

/** One non-blank, non-fence line: decide whether the pending blank line
 *  splits the group, then track nesting and append. */
function pushContentLine(st: GroupState, line: string): void {
  const mk = markerOf(line);
  if (st.pendingBreak && st.current.length > 0 && !continuesOpenList(line, mk, st.stack)) {
    closeGroup(st);
  }
  st.stack = nestingAfter(st.stack, mk);
  st.pendingBreak = false;
  st.current.push(line);
}

/**
 * Group the lines of one prose section into paragraph groups.
 *
 * Most sections are one group: blank lines mark a paragraph break and
 * start a new group. The one exception is blank lines INSIDE a list — a
 * blank line between a list item (or one of its nested children or
 * wrapped continuation rows) and the next line of the same list is
 * list-item spacing, not a paragraph break, so those lines stay in one
 * group. Loose lists must render as a single document, exactly like
 * tight ones: glamour owns the blank-line semantics (the same list
 * renders with or without the interior blank rows; the paragraph-broken
 * variant breaks the list apart and strips nesting).
 *
 * A pending blank line attaches the next line to the group when the line
 * continues the open list (see {@link continuesOpenList}); anything else —
 * plain paragraphs, dedented content — ends the group. Reconstructed
 * blank lines between groups render as paragraph breaks, as before.
 */
export function paragraphGroups(text: string): ParagraphGroup[] {
  const st: GroupState = {
    groups: [],
    current: [],
    pendingBreak: false,
    stack: [],
    fence: undefined,
    afterFence: false,
  };
  for (const line of text.split("\n")) {
    if (st.fence !== undefined) {
      pushFenceLine(st, line);
      continue;
    }
    if (st.afterFence) closeGroup(st); // content after a closing fence is
    st.afterFence = false; // never a lazy continuation of the pre-fence block
    const open = fenceOpener(line);
    if (open !== undefined) {
      // An opener mid-group closes the group so far; the fence owns the
      // next one (opener through closer, whatever blanks fall between).
      closeGroup(st);
      st.fence = open;
      st.current.push(line);
      continue;
    }
    if (line.trim() === "") {
      pushBlankLine(st);
      continue;
    }
    pushContentLine(st, line);
  }
  closeGroup(st);
  return st.groups;
}
