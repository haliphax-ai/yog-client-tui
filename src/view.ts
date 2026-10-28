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
  promptMarker: newStyle().foreground("#a78bfa").bold(true),
  inputText: newStyle(),
  cursor: newStyle().background("#7c3aed").foreground("#ffffff").bold(true),
  status: newStyle().foreground("#64748b"),
} as const;

/**
 * Render markdown at `cols` via glamour with tokyo-night styling. Returns ""
 * on renderer failure so callers can fall back to plain text.
 */
function mdRender(text: string, cols: number): string {
  try {
    return newTermRenderer(
      withStandardStyle("tokyo-night"),
      withWordWrap(Math.max(1, cols)),
    ).render(text);
  } catch {
    return "";
  }
}

/**
 * Kept as the startup hook call sites expect. The oakoliver libraries are
 * pure TypeScript (no WASM), so there is nothing to initialize.
 */
export async function initLipGloss(): Promise<void> {
  // no-op: @oakoliver/lipgloss and @oakoliver/glamour need no runtime init
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
 * Colorize tool call-line content (compact JSON args, ✓/✗ indicators) with
 * lightweight syntax highlighting. ANSI-safe: escape sequences are copied
 * through untouched and only plain runs are tokenized. Applied after wrapping
 * so tokens may already be split across fragments.
 */
export function colorizeToolLine(text: string): string {
  let out = "";
  let i = 0;
  const C = {
    key: "\x1b[38;5;39m",
    str: "\x1b[38;5;114m",
    num: "\x1b[38;5;215m",
    lit: "\x1b[38;5;213m",
    punct: "\x1b[38;5;245m",
    ok: "\x1b[38;5;41m",
    fail: "\x1b[38;5;203m",
    reset: "\x1b[0m",
  };
  const escape = (): void => {
    const rest = text.slice(i);
    const m = rest.match(/^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|^\x1b\[[0-9;?]*[ -/]*[@-~]|^\x1b[@-Z\\-_]/);
    if (m) {
      out += m[0];
      i += m[0].length;
    } else {
      i += 1;
    }
  };
  const colorize = (token: string, color: string): void => {
    out += color + token + C.reset;
  };
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === "\x1b") {
      escape();
      continue;
    }
    if (ch === "✓" || ch === "✗") {
      colorize(ch, ch === "✓" ? C.ok : C.fail);
      i += 1;
      continue;
    }
    if (ch === '"') {
      // Consume the whole string (escapes inside), then check for `:`.
      let j = i + 1;
      let closed = false;
      while (j < text.length) {
        const c = text[j] as string;
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
        while (k < text.length && (text[k] === " " || text[k] === "\t")) k += 1;
        colorize(text.slice(i, j), text[k] === ":" ? C.key : C.str);
        i = j;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }
    const num = text.slice(i).match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (num) {
      colorize(num[0], C.num);
      i += num[0].length;
      continue;
    }
    const lit = text.slice(i).match(/^(?:true|false|null)/);
    if (lit && /[^A-Za-z0-9_]/.test(text[i + lit[0].length] ?? " ")) {
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
  return out;
}

/**
 * Render tool-call arguments for the inline call line: pretty-printed,
 * whitespace-collapsed JSON capped to `max` cells — never the escaped
 * double-encoded form.
 */
export function prettyArgs(value: unknown, max: number): string {
  let text: string;
  try {
    if (typeof value === "string") text = value;
    else text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  const clean = text.replace(/\s+/g, " ").trim();
  const limit = Math.max(12, max);
  return clean.length > limit ? `${clean.slice(0, limit - 3)}...` : clean;
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
    // Header: bold + underlined white text so it separates from the body.
    const styledHeader =
      `\x1b[1m\x1b[4m\x1b[38;2;255;255;255m${arrowed}` +
      "\x1b[39m\x1b[24m\x1b[22m";
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

  const lines: string[] = [];
  for (const line of entry.lines) lines.push(...wrapText(line, cols));
  if (lines.length === 0) lines.push("");
  const rendered = kindStyle(entry.kind).render(lines.join("\n"));
  // Tool lines get JSON/✓ syntax coloring on top of the base style.
  return {
    rendered: entry.kind === "tool" ? colorizeToolLine(rendered) : rendered,
    rows: lines.length,
  };
}

/**
 * Build the visible log viewport: render every entry to its styled block
 * (markdown bubbles for prompts/responses), flatten to rows, then slice
 * `viewportRows` rows from `scrollOffset`.
 */
function buildViewport(state: RenderState): string[] {
  const rendered: string[] = [];
  for (const [entryIndex, entry] of state.entries.entries()) {
    const view = renderEntry(entry, state.cols, entryIndex === state.focusIndex);
    rendered.push(...view.rendered.split("\n"));
    rendered.push(""); // blank separator between entries
  }

  const start = Math.max(0, Math.min(state.scrollOffset, Math.max(0, rendered.length)));
  const visible: string[] = [];
  for (let i = start; i < rendered.length && visible.length < state.viewportRows; i += 1) {
    visible.push(truncateAnsi(rendered[i] as string, state.cols));
  }
  while (visible.length < state.viewportRows) visible.push("");
  return visible;
}

/** Number of rows the current entries occupy at `cols` (incl. separators). */
export function totalRows(entries: LogEntry[], cols: number): number {
  let rows = 0;
  for (const entry of entries) {
    rows += renderEntry(entry, cols).rows + 1;
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