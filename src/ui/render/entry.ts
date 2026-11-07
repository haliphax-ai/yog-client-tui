/**
 * Entry rendering: glamour markdown, per-kind styling, chunk headers, and
 * the memoized row cache.
 *
 * The cache is split in two: the parsed sections (prose/table split) are
 * cached per content signature, and the rendered rows are cached per render
 * signature. A cache hit never re-parses the entry.
 */
import type { Style } from "@oakoliver/lipgloss";
import { ST, CHUNK_HEADER } from "../theme.ts";
import { displayWidth, truncateAnsi, wrapText } from "../../util/ansi.ts";
import { colorizeToolLine } from "./colorize.ts";
import { renderMarkdown } from "./markdown.ts";
import { resultPreview } from "./formatting.ts";
import type { EntryKind, LogEntry } from "../../core/entries.ts";
import type { FocusTarget } from "../../core/focus.ts";
import {
  type TableSection,
  renderTable,
  resolveTableLayout,
  splitTableSections,
  tableRowWidth,
} from "./table/index.ts";

/** Style for an entry kind. */
function kindStyle(kind: EntryKind): Style {
  switch (kind) {
    case "user":
      return ST.user;
    case "assistant":
      return ST.assistant;
    case "tool":
    case "toolResult":
      return ST.tool;
    case "system":
      return ST.system;
    case "error":
      return ST.error;
    case "notice":
      return ST.notice; // marker+label only; the detail row styles itself
    case "status":
      return ST.statusLine;
    case "chunk":
      return ST.chunkBlock;
    case "debug":
      return ST.chunkBlock;
  }
}

/** Rows a tool-output block body shows before truncation (label excluded). */
const COLLAPSE_LINES = 5;

/** Left-border rune marking assistant prose (themed via ST.assistantBorder). */
const BORDER_RUNE = "▐";

/** A fully styled entry: its rendered rows, their count, and the row offset
 *  of every table section within the rendered block (0-based, relative to the
 *  entry's first row). Used by `revealFocus` to scroll a focused table — not
 *  just the entry that contains it — into the viewport. */
interface EntryRender {
  rendered: string;
  rows: number;
  tableOffsets: number[];
}

/**
 * Flatten glamour's theme colors out of a rendered markdown row, keeping only
 * structural emphasis (bold/italic): inside the prompt bubble the role style
 * (light-grey text on light-grey bg) must win, and background resets would
 * punch holes in it. Glamour emits colors in combined SGRs in TWO orders:
 *
 *  - `renderText` (element styling): color parts lead — `38;2;r;g;b;3` —
 *    with attributes trailing.
 *  - `Pen.toString` (the wrap writer's per-row state re-emit at soft-wrap
 *    points): attributes lead — `3;38;2;r;g;b` — with colors trailing.
 *
 * The wrap re-emit is the one that lands at CONTINUATION-row starts, so
 * missing the attr-leading form leaks glamour's theme fg (tokyo-night
 * blue-grey) into the bubble on every wrapped row and lets emphasis drift
 * into subsequent runs. Both orders are flattened the same way: every color
 * part (fg/bg/underline-color, 256- or truecolor) is dropped, attribute
 * parts (bold 1, italic 3, …) are re-emitted standalone, and a SGR of
 * nothing but colors is dropped entirely. Closing resets become attr-off
 * codes so emphasis never leaks past its run. Assistant replies keep
 * glamour's full styling.
 */
function flattenMarkdown(rows: string[]): string[] {
  return rows.map((row) =>
    row
      .replaceAll("\x1b[m", "\x1b[23m\x1b[22m")
      .replaceAll("\x1b[0m", "\x1b[23m\x1b[22m")
      .replace(
        // eslint-disable-next-line no-control-regex
        /\x1b\[([0-9;]*)m/g,
        (_m, params: string) => {
          const parts = params.split(";");
          const attrs: string[] = [];
          for (let i = 0; i < parts.length; i++) {
            const code = parts[i] as string;
            // Extended color parts: 38/48/58 consume 3 or 5 params — skip
            // them entirely (colors are flattened away).
            if (code === "38" || code === "48" || code === "58") {
              i += (parts[i + 1] === "2" ? 5 : 3) - 1;
              continue;
            }
            // Attribute parts survive; color shorthand (30-37/90-97 fg,
            // 40-47/100-107 bg) and color resets (39/49/59) are dropped.
            if (
              /^(?:[1-9]|[1-9][0-9])$/.test(code) &&
              !/^(?:3[0-9]|4[0-9]|9[0-7]|10[0-7])$/.test(code)
            ) {
              attrs.push(code);
            }
          }
          return attrs.length > 0 ? `\x1b[${attrs.join(";")}m` : "";
        },
      ),
  );
}

/**
 * O(1) content signature: line count + first/last line lengths cover every
 * mutation this codebase performs (append rows, grow last row, amend label,
 * set the token note) — tool-call entries never mutate an existing line to a
 * different length in place.
 */
function contentKeyOf(entry: LogEntry): string {
  const lines = entry.lines;
  return `${lines.length}|${lines[0]?.length ?? 0}|${lines[lines.length - 1]?.length ?? 0}`;
}

/** The cached prose/table split of one entry. */
interface SectionCache {
  contentKey: string;
  sections: TableSection[];
}

/** The cached rendered rows of one entry. */
interface RowCache {
  key: string;
  rows: string[];
  tableOffsets: number[];
}

const sectionCaches = new WeakMap<LogEntry, SectionCache>();
const rowCaches = new WeakMap<LogEntry, RowCache>();
/** Monotonic row-cache version: bumped on every render miss so cached
 *  height summaries can detect staleness in O(1). */
let revision = 0;

/** Cached aggregate height data for one entries array at one width. */
export interface HeightSummary {
  cols: number;
  /** `revision` when this summary was built; mismatch means rebuild. */
  revision: number;
  /** Number of entries the summary covers (append guard). */
  length: number;
  /** Total TERMINAL rows (incl. separators). */
  total: number;
  /** tops[i] = terminal row where entry i begins (incl. prior separators). */
  tops: number[];
}

const heightSummaries = new WeakMap<LogEntry[], HeightSummary>();

/**
 * The entry's prose/table sections, parsed once per content change.
 *
 * This is the single source of truth about which parts of an entry are
 * tables: the renderer draws the table sections, the focus ring walks the
 * same sections, and the scroll bounds measure the same sections. They
 * cannot disagree.
 */
export function sectionsOf(entry: LogEntry): TableSection[] {
  if (entry.kind !== "user" && entry.kind !== "assistant") return [];
  const contentKey = contentKeyOf(entry);
  const hit = sectionCaches.get(entry);
  if (hit !== undefined && hit.contentKey === contentKey) return hit.sections;
  const sections = splitTableSections(entry.lines.join("\n"));
  sectionCaches.set(entry, { contentKey, sections });
  return sections;
}

/** The cached rendered rows of an entry, if it has been rendered. */
export function cacheOf(entry: LogEntry): RowCache | undefined {
  return rowCaches.get(entry);
}

/**
 * The focusable units of the given entries, in document order.
 *
 * A chunk, tool, user, or assistant entry contributes one unit
 * (`{entry, table: -1}`); a prose entry with N tables contributes N table
 * units (`{entry, table: 0..N-1}`) IN ADDITION to the entry itself. The
 * entry unit comes first, then its tables — Tab walks a prose entry's
 * tables after selecting the entry, mirroring the document order.
 *
 * The units come from the same sections the renderer draws, so every table
 * that renders is a table that can be focused.
 */
export function focusUnits(entries: readonly LogEntry[]): FocusTarget[] {
  const units: FocusTarget[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as LogEntry;
    if (
      entry.kind === "chunk" ||
      entry.kind === "tool" ||
      entry.kind === "toolResult" ||
      entry.kind === "debug" ||
      entry.kind === "user" ||
      entry.kind === "assistant"
    ) {
      units.push({ entry: i, table: -1 });
    }
    let table = 0;
    for (const section of sectionsOf(entry)) {
      if (section.kind === "table") {
        units.push({ entry: i, table });
        table += 1;
      }
    }
  }
  return units;
}

/** Render a collapsible block (tool-output chunks, debug chunks). The body
 *  comes from the raw result when the entry carries one (the presenter stores
 *  the data; the renderer formats it), else from the pre-rendered body lines.
 *  Headers show `↓` when expanded (bodies <= COLLAPSE_LINES are always
 *  expanded), `→` when collapsed. */
function renderChunkLike(entry: LogEntry, cols: number, focusedTable: boolean): EntryRender {
  const body =
    entry.result !== undefined ? resultPreview(entry.result, cols) : entry.lines.slice(1);
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
  const styledHeader = `\x1b[1m\x1b[4m${headerColor}${arrowed}` + "\x1b[39m\x1b[24m\x1b[22m";
  const style = (focusedTable ? ST.chunkBlockFocus : ST.chunkBlock).width(cols);
  if (open) {
    const rows = [styledHeader, ...body];
    const rendered = style.render(rows.join("\n"));
    return { rendered, rows: rendered.split("\n").length, tableOffsets: [] };
  }
  const shown = body.slice(0, COLLAPSE_LINES);
  const hidden = body.length - shown.length;
  const rendered = style.render(
    [styledHeader, ...shown, `… +${hidden} line${hidden === 1 ? "" : "s"}`].join("\n"),
  );
  return { rendered, rows: rendered.split("\n").length, tableOffsets: [] };
}

/**
 * Render one entry to its styled block at `cols`. Prompts and responses go
 * through the glamour markdown renderer first: prompts render in a light-grey
 * padded bubble with theme colors flattened to the bubble's light-grey text
 * (emphasis kept); assistant replies keep full glamour styling, prefixed on
 * every row by a themed half-block border. Tool-output blocks are always full
 * height (header with exit status + output, black bg, dark-grey text);
 * headers show `↓` when expanded (bodies <= COLLAPSE_LINES are always
 * expanded), `→` when collapsed. Other rows wrap plain.
 *
 * Every chunk is HARD-wrapped: prose, tool bodies, and tool-arg rows are
 * programmatically word-wrapped to the block's body width (cols-2 for
 * padded/bordered blocks, cols otherwise), so no row exceeds the terminal
 * width and the terminal never soft-wraps a chunk.
 */
function renderEntry(
  entry: LogEntry,
  cols: number,
  focusedTable = false,
  focusedTableIndex = -1,
): EntryRender {
  if (entry.kind === "user" || entry.kind === "assistant") {
    const isUser = entry.kind === "user";
    // Prompt: 1-cell padding each side sits INSIDE the style width, so the
    // content wraps at cols-2 while the block spans the full terminal.
    // Assistant: rows are prefixed with the border cell + one space, so the
    // prose wraps at cols-2 too and the border gutter survives wrapping.
    const bodyW = Math.max(1, cols - 2);
    const sections = sectionsOf(entry);
    // Render each section: prose through glamour, tables through the table
    // renderer. The FIRST and LAST sections of the sequence render WITHOUT
    // their outer margin — spacing to the entry's neighbors is the
    // separator's job, so a leading table sits flush under the entry start
    // and a trailing one flush above the entry end.
    const first = sections[0];
    const last = sections[sections.length - 1];
    const parts: string[] = [];
    const tableOffsets: number[] = [];
    let tableIndex = 0;
    for (const section of sections) {
      if (section.kind === "prose") {
        const md = renderMarkdown(section.text, bodyW);
        parts.push(
          ...(md.length > 0 ? (isUser ? flattenMarkdown(md) : md) : wrapText(section.text, bodyW)),
        );
        continue;
      }
      // A table section. The column layout comes from the layout engine:
      // the collapsed layout fits the viewport, the expanded one widens the
      // panes that were squeezed. The expanded row may exceed `cols` —
      // horizontal scroll reveals it.
      // Focus is per-table: only the focused table renders blue; every
      // other table in the entry renders white (unfocused).
      const isFocusedTable = focusedTable && tableIndex === focusedTableIndex;
      // Record the row offset of this table BEFORE its rendered rows are
      // appended — that offset is what `revealFocus` needs to scroll the
      // table (not just the entry that contains it) into the viewport.
      tableOffsets.push(parts.length);
      const state = entry.tables?.[tableIndex];
      const natural = section.table.columns.map((c) => c.width);
      const layout = resolveTableLayout(natural, bodyW, state?.expanded === true);
      const totalW = tableRowWidth(layout.widths);
      const maxScroll = Math.max(0, totalW - bodyW);
      const scrollX = Math.max(0, Math.min(state?.scrollX ?? 0, maxScroll));
      const rows = renderTable(
        section.table,
        bodyW,
        isFocusedTable,
        scrollX,
        { top: section !== first, bottom: section !== last },
        layout.widths,
      );
      // The table's cell budget is the entry's body width: a row wider
      // than that (the expanded layout) is clipped to the visible window.
      for (const row of rows) parts.push(truncateAnsi(row, bodyW));
      tableIndex++;
    }
    if (parts.length === 0) parts.push("");
    if (isUser) {
      const rendered = ST.user.width(cols).render(parts.join("\n"));
      return { rendered, rows: rendered.split("\n").length, tableOffsets };
    }
    // Style each prose row by itself, then glue the border in front — the
    // border never crosses the prose styling and vice versa, and pre-wrapped
    // rows (md or wrapText, both <= bodyW = cols-2 cells) leave room for the
    // two-cell gutter on every row.
    const border = ST.assistantBorder.render(BORDER_RUNE);
    const rows = parts.map((row) => `${border} ${row}`);
    const rendered = rows.join("\n");
    return { rendered, rows: rows.length, tableOffsets };
  }

  if (entry.kind === "chunk" || entry.kind === "debug") {
    return renderChunkLike(entry, cols, focusedTable);
  }

  if (entry.kind === "tool" || entry.kind === "toolResult") {
    // Identical geometry in both states (1-cell side padding, full width):
    // focusing only recolors, and expansion persists regardless of focus.
    // Collapsed: cell-cap the summary line to the body width — a long tool-error
    // line must never wrap (a wrapped JSON blob reads as several entries). When
    // truncated, drop one more cell and append a UTF-8 ellipsis so the marker
    // fits within the same budget.
    // Expanded: wrap the full body at the body width (hard wrap).
    const rows =
      entry.expanded && entry.full !== undefined
        ? [entry.label ?? entry.lines[0] ?? "", ...wrapText(entry.full, Math.max(1, cols - 2))]
        : (() => {
            // Collapsed: the note rides at the end of the (capped) line; the
            // cap shrinks by the note's width so both always fit the budget.
            const line = entry.lines[0] ?? "";
            const note = entry.tokenNote === undefined ? "" : ` · ${entry.tokenNote}`;
            const cap = Math.max(1, cols - 2 - displayWidth(note));
            if (displayWidth(line) <= cap) return note === "" ? [line] : [`${line}${note}`];
            return cap > 1 ? [`${truncateAnsi(line, cap - 1)}…${note}`] : [`…${note}`];
          })();
    const style = (focusedTable ? ST.toolFocus : ST.toolPlain).width(cols);
    const rendered = style.render(rows.join("\n"));
    return {
      rendered: colorizeToolLine(rendered),
      rows: rendered.split("\n").length,
      tableOffsets: [],
    };
  }

  if (entry.kind === "notice" || entry.kind === "error") {
    // Notices and errors are never focusable, so collapsing them would hide
    // content forever: they render in FULL, as a SINGLE logical line — the
    // padded label in its themed color (light blue for info, yellow for wait
    // ⚠️, blue-grey for lifecycle 🪧 notices), a mid-dot separator, and the
    // detail dimmed — WORD-WRAPPED at the body width so nothing is ever
    // truncated and the block never soft-wraps past the terminal edge.
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
        : `${noticeStyle.render(label)}\x1b[39m· ${ST.noticeDetail.render(detail)}`;
    const rows = wrapText(line, Math.max(1, cols - 2));
    if (rows.length === 0) rows.push("");
    return {
      rendered: rows.join("\n"),
      rows: rows.length,
      tableOffsets: [],
    };
  }

  if (entry.kind === "status") {
    // Per-turn summary line, one line: dark grey text on the normal
    // background with 1-cell horizontal padding, capped to the terminal width
    // (the padding sits inside the style, so the content budget is cols-2).
    const line = entry.lines[0] ?? "";
    const budget = Math.max(0, cols - 2);
    return {
      rendered: ST.statusLine.render(truncateAnsi(line, budget)),
      rows: 1,
      tableOffsets: [],
    };
  }

  // The plain fallback (system-kind transcript rows, any future kind):
  // wrap every logical line to the terminal width, then style each wrapped
  // row individually — lipgloss would style the joined string WITHOUT
  // wrapping, leaving one overwide row for the frame to truncate. Styling
  // per row keeps every kind's color on all of its rows (no drift from the
  // kind-level style), and rows.length stays one-terminal-row-per-row.
  const lines: string[] = [];
  for (const line of entry.lines) lines.push(...wrapText(line, cols));
  if (lines.length === 0) lines.push("");
  const style = kindStyle(entry.kind);
  const rendered = lines.map((line) => style.render(line)).join("\n");
  return { rendered, rows: lines.length, tableOffsets: [] };
}

/**
 * Render signature for the row cache: everything `renderEntry` derives
 * output from — display width, the focus flag, the collapse/expand toggles,
 * the content signature (streaming entries mutate `lines`, tool calls get
 * `label`/`lines[0]` amended when the result lands), and the per-table state
 * (expansion and scroll offset).
 */
function renderKeyOf(
  entry: LogEntry,
  cols: number,
  focused: boolean,
  focusedTableIndex: number,
): string {
  const tables = entry.tables;
  const tableState =
    tables === undefined
      ? ""
      : Object.keys(tables)
          .map(
            (k) => `${k}:${tables[Number(k)]?.expanded ? 1 : 0}:${tables[Number(k)]?.scrollX ?? 0}`,
          )
          .join(",");
  return `${cols}|${focused ? 1 : 0}|${focusedTableIndex}|${entry.collapsed ? 1 : 0}|${
    entry.expanded ? 1 : 0
  }|${contentKeyOf(entry)}|${entry.label ?? ""}|${entry.tokenNote ?? ""}|${tableState}`;
}

/**
 * Rendered rows for one entry, memoized on the `LogEntry` object. The key
 * captures everything `renderEntry` derives output from (see
 * {@link renderKeyOf}); a matching key means a byte-identical render — safe
 * to reuse.
 *
 * A cache hit performs no table parse and no width measurement: the
 * prose/table split is cached separately (keyed by the content signature).
 */
export function cachedRowData(
  entry: LogEntry,
  cols: number,
  focused = false,
  focusedTableIndex = -1,
): RowCache {
  const key = renderKeyOf(entry, cols, focused, focusedTableIndex);
  const hit = rowCaches.get(entry);
  if (hit !== undefined && hit.key === key) return hit;
  const rendered = renderEntry(entry, cols, focused, focusedTableIndex);
  const rows = rendered.rendered.split("\n");
  const cache: RowCache = { key, rows, tableOffsets: rendered.tableOffsets };
  rowCaches.set(entry, cache);
  revision += 1;
  return cache;
}

/** Backwards-compatible view: the cached rows of one entry. */
export function cachedRows(
  entry: LogEntry,
  cols: number,
  focused = false,
  focusedTableIndex = -1,
): string[] {
  return cachedRowData(entry, cols, focused, focusedTableIndex).rows;
}

/** Record a direct entry mutation: evict its cached rows and bump the
 *  revision, so height summaries rebuild on the next query. Components call
 *  this when they mutate an entry outside a render pass (e.g. toggles,
 *  appends, token notes) that the row cache would otherwise not observe. */
export function noteMutation(entry?: LogEntry): void {
  if (entry !== undefined) rowCaches.delete(entry);
  revision += 1;
}

/** Row offsets of every table section inside an entry's rendered block.
 *  Returns `undefined` for entries that carry no table (or whose cache
 *  hasn't been populated yet). Used by `revealFocus` to scroll a focused
 *  table — not just the entry that contains it — into the viewport. */
export function tableOffsetsOf(entry: LogEntry): number[] | undefined {
  return rowCaches.get(entry)?.tableOffsets;
}

/**
 * Number of TERMINAL rows the given entries occupy at `cols` (incl.
 * separators). Rows are hard-wrapped to the terminal width, so each row
 * occupies exactly one terminal row.
 *
 * Backed by a cached summary per (entries array identity, cols): the total
 * is reused verbatim while the row-cache revision is unchanged — steady-state
 * frames pay O(1) here instead of re-counting every row.
 */
export function heightSummaryOf(entries: LogEntry[], cols: number): HeightSummary {
  const cached = heightSummaries.get(entries);
  if (
    cached !== undefined &&
    cached.cols === cols &&
    cached.revision === revision &&
    cached.length === entries.length
  ) {
    return cached;
  }
  const n = entries.length;
  const tops = Array.from({ length: n + 1 }, () => 0);
  tops[0] = 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += cachedRows(entries[i] as LogEntry, cols).length + 1;
    tops[i + 1] = total;
  }
  const summary: HeightSummary = { cols, revision, length: n, total, tops };
  heightSummaries.set(entries, summary);
  return summary;
}

export function totalRows(entries: LogEntry[], cols: number): number {
  return heightSummaryOf(entries, cols).total;
}
