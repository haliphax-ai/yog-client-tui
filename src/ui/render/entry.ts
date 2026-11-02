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
      return ST.tool;
    case "system":
      return ST.system;
    case "error":
      return ST.error;
    case "notice":
      return ST.notice; // marker+label only; the detail row styles itself
    case "chunk":
      return ST.chunkBlock;
  }
}

/** Rows a tool-output block body shows before truncation (label excluded). */
const COLLAPSE_LINES = 5;


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
 * O(1) content signature: line count + first/last line lengths cover every
 * mutation this codebase performs (append rows, grow last row, amend label).
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
 * A chunk or tool entry contributes one unit (`{entry, table: -1}`); a
 * prose entry with N tables contributes N units (`{entry, table: 0..N-1}`).
 * The units come from the same sections the renderer draws, so every table
 * that renders is a table that can be focused.
 */
export function focusUnits(entries: readonly LogEntry[]): FocusTarget[] {
  const units: FocusTarget[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as LogEntry;
    if (entry.kind === "chunk" || entry.kind === "tool") {
      units.push({ entry: i, table: -1 });
      continue;
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

/**
 * Render one entry to its styled block at `cols`. Prompts and responses go
 * through the glamour markdown renderer first: prompts render in a light-grey
 * padded bubble with theme colors flattened to the bubble's light-grey text
 * (emphasis kept); assistant replies keep full glamour styling, prefixed on
 * every row by a themed half-block border. Tool-output blocks are always full
 * height (header with exit status + output, black bg, dark-grey text);
 * headers show `↓` when expanded (bodies <= COLLAPSE_LINES are always
 * expanded), `→` when collapsed. Other rows wrap plain.
 */
function renderEntry(
  entry: LogEntry,
  cols: number,
  focusedTable = false,
  focusedTableIndex = -1,
): EntryRender {
  if (entry.kind === "user" || entry.kind === "assistant") {
    const isUser = entry.kind === "user";
    // Prompts and assistant prose now wrap at the full terminal width:
    // the user bubble's vertical padding (1 row top/bottom) and the assistant's
    // former border gutter are gone; only the background delineates blocks.
    const bodyW = Math.max(1, cols);
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
    // Assistant: style each prose row with the assistant style (white text,
    // no border, no padding — full-width rows for easy selection).
    const rows = parts.map((row) => ST.assistant.render(row));
    const rendered = rows.join("\n");
    return { rendered, rows: rows.length, tableOffsets };
  }

  if (entry.kind === "chunk") {
    // The body comes from the raw result when the entry carries one (the
    // presenter stores the data; the renderer formats it), else from the
    // pre-rendered body lines.
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
      const rendered = style.render([styledHeader, ...body].join("\n"));
      return { rendered, rows: rendered.split("\n").length, tableOffsets: [] };
    }
    const shown = body.slice(0, COLLAPSE_LINES);
    const hidden = body.length - shown.length;
    const rendered = style.render(
      [styledHeader, ...shown, `… +${hidden} line${hidden === 1 ? "" : "s"} (focus, Enter)`].join(
        "\n",
      ),
    );
    return { rendered, rows: rendered.split("\n").length, tableOffsets: [] };
  }

  if (entry.kind === "tool") {
    // Identical geometry in both states (1-cell side padding, full width):
    // focusing only recolors, and expansion persists regardless of focus.
    // Collapsed: cell-cap the line to the body width — a long tool-error
    // line must never wrap (a wrapped JSON blob reads as several entries).
    // Expanded: wrap the full body as before.
    const rows =
      entry.expanded && entry.full !== undefined
        ? [entry.label ?? entry.lines[0] ?? "", ...wrapText(entry.full, Math.max(1, cols - 2))]
        : [truncateAnsi(entry.lines[0] ?? "", Math.max(1, cols - 2))];
    const style = (focusedTable ? ST.toolFocus : ST.toolPlain).width(cols);
    const rendered = style.render(rows.join("\n"));
    return {
      rendered: colorizeToolLine(rendered),
      rows: rendered.split("\n").length,
      tableOffsets: [],
    };
  }

  if (entry.kind === "notice") {
    // Terminal-state notice, one line (like the status bar's dot-separated
    // items): the padded label in its themed color, the mid-dot in the
    // terminal's default foreground, and the detail dimmed — all capped to
    // the terminal width.
    const label = entry.lines[0] ?? "";
    const detail = entry.lines[1] ?? "";
    // 1 pad + label + 3 (" · ") + detail; -4 when the dot is present so the
    // separator always survives the cap.
    const budget = Math.max(0, cols - 2 - (detail === "" ? 0 : 3));
    const head = ST.notice.render(truncateAnsi(label, budget));
    const body =
      detail === ""
        ? head
        : `${head}\x1b[39m· ${ST.noticeDetail.render(truncateAnsi(detail, Math.max(0, budget - displayWidth(label))))}`;
    return { rendered: body, rows: 1, tableOffsets: [] };
  }

  const lines: string[] = [];
  for (const line of entry.lines) lines.push(...wrapText(line, cols));
  if (lines.length === 0) lines.push("");
  const rendered = kindStyle(entry.kind).render(lines.join("\n"));
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
  }|${contentKeyOf(entry)}|${entry.label ?? ""}|${tableState}`;
}

/**
 * Rendered rows for one entry, memoized on the `LogEntry` object. The key
 * captures everything `renderEntry` derives output from (see
 * {@link renderKeyOf}). Entries only ever grow (in place for the same
 * signature), so a matching key means a byte-identical render — safe to
 * reuse.
 *
 * A cache hit performs no table parse: the prose/table split is cached
 * separately, keyed by the content signature.
 */
export function cachedRows(
  entry: LogEntry,
  cols: number,
  focused = false,
  focusedTableIndex = -1,
): string[] {
  const key = renderKeyOf(entry, cols, focused, focusedTableIndex);
  const hit = rowCaches.get(entry);
  if (hit !== undefined && hit.key === key) return hit.rows;
  const rendered = renderEntry(entry, cols, focused, focusedTableIndex);
  const rows = rendered.rendered.split("\n");
  rowCaches.set(entry, { key, rows, tableOffsets: rendered.tableOffsets });
  return rows;
}

/** Row offsets of every table section inside an entry's rendered block.
 *  Returns `undefined` for entries that carry no table (or whose cache
 *  hasn't been populated yet). Used by `revealFocus` to scroll a focused
 *  table — not just the entry that contains it — into the viewport. */
export function tableOffsetsOf(entry: LogEntry): number[] | undefined {
  return rowCaches.get(entry)?.tableOffsets;
}

/** Number of rows the given entries occupy at `cols` (incl. separators). */
export function totalRows(entries: LogEntry[], cols: number): number {
  let rows = 0;
  for (const entry of entries) {
    rows += cachedRows(entry, cols).length + 1;
  }
  return rows;
}
