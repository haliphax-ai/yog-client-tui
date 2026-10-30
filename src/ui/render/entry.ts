/**
 * Entry rendering: glamour markdown, per-kind styling, chunk headers, and
 * the memoized row cache.
 */
import type { Style } from "@oakoliver/lipgloss";
import { ST, CHUNK_HEADER } from "../theme.ts";
import { displayWidth, matchEscape, stripAnsi, truncateAnsi, wrapText } from "../../util/ansi.ts";
import { colorizeToolLine } from "./colorize.ts";
import {
  highlightBlock,
  renderInlineMarkdown,
  renderMarkdown,
  trimLeading,
} from "./markdown.ts";
import type { EntryKind, LogEntry } from "./types.ts";
import {
  parseTable,
  renderTable,
  splitTableSections,
  TableComponent,
  type ParsedTable,
} from "./table.ts";

export { highlightBlock, renderMarkdown } from "./markdown.ts";

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

/** Left-border rune marking assistant prose (themed via ST.assistantBorder). */
const BORDER_RUNE = "▐";

/** A fully styled entry: its rendered rows and their count. */
interface EntryRender {
  rendered: string;
  rows: number;
}

/**
 * Render a parsed table as styled rows: box-drawing borders, bold header,
 * zebra-striped data rows, and 1-cell top/bottom margins. Width-capped to
 * `cols` — columns scale proportionally when the table is too wide.

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
 * (emphasis kept); assistant replies keep full glamour styling, prefixed on
 * every row by a themed half-block border. Tool-output blocks are always full
 * height (header with exit status + output, black bg, dark-grey text);
 * headers show `↓` when expanded (bodies <= COLLAPSE_LINES are always
 * expanded), `→` when collapsed. Other rows wrap plain.
 */
function renderEntry(entry: LogEntry, cols: number, focused = false): EntryRender {
  if (entry.kind === "user" || entry.kind === "assistant") {
    const isUser = entry.kind === "user";
    const text = entry.lines.join("\n");
    // Prompt: 1-cell padding each side sits INSIDE the style width, so the
    // content wraps at cols-2 while the block spans the full terminal.
    // Assistant: rows are prefixed with the border cell + one space, so the
    // prose wraps at cols-2 too and the border gutter survives wrapping.
    const bodyW = Math.max(1, cols - 2);
    const sections = splitTableSections(text);
    // Render each section: prose through glamour, tables through the
    // viewport-backed component. The FIRST and LAST sections of the sequence
    // render WITHOUT their outer margin — spacing to the entry's neighbors
    // is the separator's job, so a leading table sits flush under the entry
    // start and a trailing one flush above the entry end. The same rule will
    // apply to any future component type (images, thinking output).
    const first = sections[0];
    const last = sections[sections.length - 1];
    const parts: string[] = [];
    for (const section of sections) {
      if (section.kind === "prose") {
        const md = renderMarkdown(section.text, bodyW);
        parts.push(...(md.length > 0 ? (isUser ? flattenMarkdown(md) : md) : wrapText(section.text, bodyW)));
      } else {
        // Route table sections through TableComponent so the shared viewport
        // logic (clamp/slice/pad) is used instead of a bypass call.
        const tc = new TableComponent();
        tc.setTable(section.table);
        tc.setMargin({
          top: section !== first,
          bottom: section !== last,
        });
        tc.onFocus(focused);
        parts.push(...tc.render({ cols: bodyW }));
      }
    }
    if (parts.length === 0) parts.push("");
    if (isUser) {
      const rendered = ST.user.width(cols).render(parts.join("\n"));
      return { rendered, rows: rendered.split("\n").length };
    }
    // Style each prose row by itself, then glue the border in front — the
    // border never crosses the prose styling and vice versa, and pre-wrapped
    // rows (md or wrapText, both <= bodyW = cols-2 cells) leave room for the
    // two-cell gutter on every row.
    const border = ST.assistantBorder.render(BORDER_RUNE);
    const rows = parts.map((row) => `${border} ${row}`);
    const rendered = rows.join("\n");
    return { rendered, rows: rows.length };
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
    // Collapsed: cell-cap the line to the body width — a long tool-error
    // line must never wrap (a wrapped JSON blob reads as several entries).
    // Expanded: wrap the full body as before.
    const rows =
      entry.expanded && entry.full !== undefined
        ? [entry.label ?? entry.lines[0] ?? "", ...wrapText(entry.full, Math.max(1, cols - 2))]
        : [truncateAnsi(entry.lines[0] ?? "", Math.max(1, cols - 2))];
    const style = (focused ? ST.toolFocus : ST.toolPlain).width(cols);
    const rendered = style.render(rows.join("\n"));
    return { rendered: colorizeToolLine(rendered), rows: rendered.split("\n").length };
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
    return { rendered: body, rows: 1 };
  }

  const lines: string[] = [];
  for (const line of entry.lines) lines.push(...wrapText(line, cols));
  if (lines.length === 0) lines.push("");
  const rendered = kindStyle(entry.kind).render(lines.join("\n"));
  return { rendered, rows: lines.length };
}

/**
 * Table signature for the cache key: column count + row count + per-column
 * widths. Captures everything `renderTable` derives output from — if any
 * of these change, the rendered table changes too.
 */
function tableSignature(lines: string[]): string {
  const t = parseTable(lines.join("\n"));
  if (!t) return "0";
  const widths = t.columns.map((c) => c.width).join(",");
  return `${t.columns.length}:${t.rows.length}:${widths}`;
}

/**
 * Rendered rows for one entry, memoized on the `LogEntry` object. The key
 * captures everything `renderEntry` derives output from: display width, the
 * focus flag, the expand/collapse toggles, a content signature (streaming
 * entries mutate `lines`, tool calls get `label`/`lines[0]` amended when the
 * result lands), and a table signature (column count + row count + widths).
 * Entries only ever grow (in place for the same signature), so a matching
 * key means a byte-identical render — safe to reuse.
 */
export function cachedRows(entry: LogEntry, cols: number, focused = false): string[] {
  const lines = entry.lines;
  // O(1) content signature: line count + first/last line lengths cover every
  // mutation this codebase performs (append rows, grow last row, amend label).
  const key = `${cols}|${focused ? 1 : 0}|${entry.collapsed ? 1 : 0}|${
    entry.expanded ? 1 : 0
  }|${lines.length}|${lines[0]?.length ?? 0}|${lines[lines.length - 1]?.length ?? 0}|${
    entry.label ?? ""
  }|${tableSignature(lines)}`;
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