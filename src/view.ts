/**
 * Presentation layer — everything about drawing the frame lives here.
 *
 * The screen is composed bottom-up: the chat log viewport (all rows above the
 * input bar), the input bar (prompt marker + text + cursor), and a status
 * line (model, connection/session state). `render()` turns plain UI state
 * into one styled frame string; `main.ts` writes it. No network code here.
 */
import {
  joinHorizontal,
  joinVertical,
  Left,
  newStyle,
  stringWidth,
  stripAnsi as lgStripAnsi,
  Top,
  truncate as lgTruncate,
  wrap as lgWrap,
  type Style,
} from "@oakoliver/lipgloss";
import {
  newTermRenderer,
  type TermRenderer,
  withStandardStyle,
  withWordWrap,
} from "@oakoliver/glamour";

/** What kind of log entry this is (drives its styling). */
export type EntryKind = "user" | "assistant" | "tool" | "system" | "error" | "chunk";

/** One entry in the chat log (logical lines, before wrapping). */
export interface LogEntry {
  kind: EntryKind;
  lines: string[];
  /** True while this entry is still receiving streamed content. */
  streaming?: boolean;
  /** Collapsible block: lines[0] is a label, lines[1..] are pre-styled,
   *  pre-wrapped content (tool output chunks). Collapsed shows a bounded
   *  preview; focus + Enter expands to the full content. */
  collapsed?: boolean;
  /** Tool-call entry: focus + Enter expands the full args (flat view). */
  expanded?: boolean;
  /** Tool label (`⚙️ name ✅`) so the check sits before the args in both
   *  collapsed and expanded views. */
  label?: string;
  /** Compact args text (re-appended after `label` when the check arrives). */
  argsCompact?: string;
  /** Full (untruncated) args text for the expanded view. */
  full?: string;
  /** Memoized rendered rows (internal — do not mutate from outside view.ts). */
  cache?: { entry: LogEntry; key: string; rows: string[] };
}

/** Everything `render()` needs to produce a frame. */
export interface RenderState {
  entries: LogEntry[];
  /** First visible logical line index (from the scroll offset). */
  scrollOffset: number;
  /** Rows available to the log viewport. */
  viewportRows: number;
  /** Terminal width in columns. */
  cols: number;
  /** Prompt marker shown in front of the input text. */
  promptMarker: string;
  /** Raw input buffer. */
  input: string;
  /** Cursor index within the input buffer (code units). */
  cursor: number;
  /** Horizontal scroll of the input window (code units). */
  inputScroll: number;
  /** Status line content. */
  status: string;
  /** Busy indicator frame; undefined when idle. */
  busy: string | undefined;
  /** Index of the focused log entry (-1 = none); focused entries get a
   *  highlight and Enter expands/collapses them when they are chunks. */
  focusIndex: number;
}

/** Styling map. Tool-output blocks: black bg, dark grey text, 1-cell padding. */
const ST = {
  /** Prompt: dark grey bg, light grey text, 1-cell padding, no margin. */
  user: newStyle()
    .foreground("#d4d4d8")
    .background("#3f3f46")
    .padding(1),
  /** Response: normal background, white text; spacing comes from the uniform entry separator. */
  assistant: newStyle().foreground("#ffffff"),
  tool: newStyle().foreground("#a78bfa"),
  system: newStyle().foreground("#94a3b8"),
  error: newStyle().foreground("#ef4444").bold(true),
  /** Tool block (unfocused): black bg, dark grey text, 1-cell padding. */
  chunkBlock: newStyle()
    .foreground("#a1a1aa")
    .background("#000000")
    .padding(1),
  /** Tool block (focused): white text on dark blue, same padding. */
  chunkBlockFocus: newStyle()
    .foreground("#ffffff")
    .background("#1e3a8a")
    .padding(1),
  /** Tool call (unfocused): transparent bg, purple text, same padding. */
  toolPlain: newStyle().foreground("#a78bfa").padding(0, 1),
  /** Focused tool call: dark blue bar, white text (same padding — no jitter). */
  toolFocus: newStyle().foreground("#ffffff").background("#1e3a8a").padding(0, 1),
  promptMarker: newStyle().foreground("#a78bfa").bold(true),
  inputText: newStyle(),
  cursor: newStyle().background("#7c3aed").foreground("#ffffff").bold(true),
  status: newStyle().foreground("#64748b"),
} as const;

/** Memoized glamour renderers, keyed by wrap width (max 8 before reuse). */
const mdRenderers = new Map<number, TermRenderer>();

/** Glamour renderer for `cols` (constructed once per width, then reused). */
function mdRenderer(cols: number): TermRenderer {
  const width = Math.max(1, cols);
  const cached = mdRenderers.get(width);
  if (cached) return cached;
  const renderer = newTermRenderer(
    withStandardStyle("tokyo-night"),
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

/** Width of a string in terminal cells, ignoring ANSI escape sequences. */
export function displayWidth(text: string): number {
  return stringWidth(text);
}

/** Remove ANSI escape sequences (CSI, OSC, single-character escapes). */
export function stripAnsi(text: string): string {
  return lgStripAnsi(text);
}

/** Match one ANSI escape sequence at the start of `rest`, if any. */
function matchEscape(rest: string): string | undefined {
  const esc = rest.match(
    /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|^\x1b\[[0-9;?]*[ -/]*[@-~]|^\x1b[@-Z\\-_]/,
  );
  return esc ? esc[0] : undefined;
}

/** Truncate to `max` display cells, keeping any leading ANSI sequences. */
function truncateAnsi(text: string, max: number): string {
  return max <= 0 ? "" : lgTruncate(text, max);
}



/**
 * Word-wrap one line to `cols` (ANSI-aware, hard-breaks overlong tokens) via
 * the library's cell-accurate wrap; blank lines are preserved.
 */
export function wrapText(text: string, cols: number): string[] {
  if (cols < 1) return [""];
  return text
    .split("\n")
    .flatMap((line) => (line === "" ? [""] : lgWrap(line, cols).split("\n")));
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

/**
 * Colorize tool call-line content (compact JSON args, ✅/❌ indicators) with
 * lightweight syntax highlighting. ANSI-safe: escape sequences are copied
 * through untouched and plain runs are tokenized. Runs per display row: the
 * style's row prefix (pad + fg resets) is held and flushed first, then any
 * color carried from a string token split across a wrap is re-emitted — so
 * continuation rows keep their formatting.
 */
export function colorizeToolLine(text: string): string {
  const C = {
    key: "\x1b[38;5;39m",
    str: "\x1b[38;5;114m",
    num: "\x1b[38;5;215m",
    lit: "\x1b[38;5;213m",
    punct: "\x1b[38;5;245m",
    ok: "\x1b[38;5;41m",
    fail: "\x1b[38;5;203m",
    reset: "\x1b[39m", // fg only — a full reset would punch holes in focus-bar bg
  };
  const ESC =
    /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|^\x1b\[[0-9;?]*[ -/]*[@-~]|^\x1b[@-Z\\-_]/;
  let pending = ""; // open token color carried across a row split
  const outRows: string[] = [];

  for (const row of text.split("\n")) {
    let out = "";
    let head = ""; // held row prefix: style escapes + pad/indent spaces
    let headDone = false;
    const carry = pending;
    pending = "";
    const inStringInit = carry !== "";
    if (inStringInit) pending = carry; // keep the string color alive
    let i = 0;
    let inString = inStringInit; // string carried across a row split

    const flushHead = (): void => {
      out += head;
      head = "";
      if (carry) out += carry; // after the prefix, before the content
      headDone = true;
    };
    const colorize = (token: string, color: string, open = false): void => {
      if (!headDone) flushHead();
      out += color + token + (open ? "" : C.reset);
      if (open) pending = color;
    };
    const escape = (): void => {
      const m = row.slice(i).match(ESC);
      if (m) {
        if (headDone) out += m[0];
        else head += m[0];
        i += m[0].length;
      } else {
        i += 1; // drop a bare ESC
      }
    };

    while (i < row.length) {
      const ch = row[i] as string;
      if (ch === "\x1b") {
        escape();
        continue;
      }
      if (!headDone) {
        if (ch === " ") {
          head += ch; // prefix pad / content indent
          i += 1;
          continue;
        }
        flushHead();
      }
      if (inString) {
        // String continued from the previous row: keep carry color, skip
        // tokenization; only a \" can close it.
        if (ch === '"') {
          colorize("\"", C.str);
          inString = false;
          pending = "";
        } else {
          out += ch;
        }
        i += 1;
        continue;
      }
      if (ch === "✅" || ch === "❌" || ch === "✓" || ch === "✗") {
        let end = i + 1;
        if (row[end] === "\uFE0F") end += 1;
        colorize(row.slice(i, end), ch === "✅" || ch === "✓" ? C.ok : C.fail);
        i = end;
        continue;
      }
      if (ch === '"') {
        if (inString) {
          // Closing quote of a string carried across rows.
          colorize("\"", C.str);
          inString = false;
          pending = "";
          i += 1;
          continue;
        }
        let j = i + 1;
        let closed = false;
        while (j < row.length) {
          const c = row[j] as string;
          if (c === "\\") {
            j += 2;
            continue;
          }
          if (c === '"') {
            closed = true;
            j += 1;
            break;
          }
          j += 1;
        }
        if (closed) {
          let k = j;
          while (k < row.length && (row[k] === " " || row[k] === "\t")) k += 1;
          colorize(row.slice(i, j), row[k] === ":" ? C.key : C.str);
          i = j;
          continue;
        }
        // Open at row end (wrap split): color to end, re-emit next row.
        colorize(row.slice(i), C.str, true);
        inString = true;
        i = row.length;
        continue;
      }
      const num = row.slice(i).match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (num) {
        colorize(num[0], C.num);
        i += num[0].length;
        continue;
      }
      const lit = row.slice(i).match(/^(?:true|false|null)/);
      if (lit && /[^A-Za-z0-9_]/.test(row[i + lit[0].length] ?? " ")) {
        colorize(lit[0], C.lit);
        i += lit[0].length;
        continue;
      }
      if ("{}[],:".includes(ch)) {
        colorize(ch, C.punct);
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
    }
    if (!headDone && head !== "") out += head; // prefix-only row
    outRows.push(out);
  }
  return outRows.join("\n");
}

/**
 * Render tool-call arguments as JSON. `compact` (default): whitespace-
 * collapsed, capped to `max` cells with an ellipsis — the inline call line.
 * `pretty`: 2-space indented, uncapped — the expanded view.
 */
export function prettyArgs(
  value: unknown,
  max: number,
  mode: "compact" | "pretty" = "compact",
): string {
  let text: string;
  try {
    if (typeof value === "string") text = value;
    else text = JSON.stringify(value, undefined, mode === "pretty" ? 2 : undefined) ?? String(value);
  } catch {
    text = String(value);
  }
  if (mode === "pretty") return text;
  const clean = text.replace(/\s+/g, " ").trim();
  const limit = Math.max(12, max);
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

/**
 * Body rows for a tool-result block. The bash tool's shape (stdout/stderr)
 * is rendered as real text — never the JSON-escaped blob; anything else is
 * syntax-highlighted JSON, falling back to plain wrapped lines. Returns
 * undefined when there is nothing worth showing (the exit status then lives
 * in the block header alone).
 */
function previewBody(result: unknown, cols: number): string[] | undefined {
  const target = Math.max(1, cols - 2);
  const CAP = 500;

  // bash-shaped result: stdout/stderr as text (exit status is in the header).
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>;
    const out = obj["stdout"];
    const err = obj["stderr"];
    if (typeof out === "string" || typeof err === "string") {
      const rows: string[] = [];
      for (const chunk of [out, err]) {
        if (typeof chunk !== "string" || chunk.trim() === "") continue;
        const body = chunk.replace(/\n$/, "").split("\n");
        for (const line of body) {
          if (rows.length >= CAP) break;
          rows.push(...wrapText(line, target));
        }
      }
      return rows.length > 0 ? rows : undefined;
    }
  }

  const highlighted = highlightBlock(result, target);
  if (highlighted && highlighted.length > 0) return highlighted;
  const text =
    typeof result === "string"
      ? result
      : (JSON.stringify(result, null, 2) ?? String(result));
  if (text.trim() === "") return undefined;
  const plain = text.split("\n");
  if (plain.length > CAP) return plain.slice(0, CAP).flatMap((line) => wrapText(line, target));
  return plain.flatMap((line) => wrapText(line, target));
}

/** Exit/runtime status for a tool result: `exit 0 · 42ms` ("" if none). */
export function resultStatus(result: unknown): string {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return "";
  const obj = result as Record<string, unknown>;
  const exit = typeof obj["exitCode"] === "number" ? `exit ${obj["exitCode"]}` : "";
  const runtime = typeof obj["runtimeMs"] === "number" ? ` · ${obj["runtimeMs"]}ms` : "";
  return exit || runtime ? `${exit}${runtime}` : "";
}

/** Body rows for a tool-result block ([] when there is nothing to show). */
export function resultPreview(result: unknown, cols: number): string[] {
  return previewBody(result, cols) ?? [];
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
      ? "\x1b[38;2;255;255;255m"
      : Number(exitCode[1]) === 0
        ? "\x1b[38;2;0;255;0m" // bright green
        : "\x1b[38;2;255;0;0m"; // bright red
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