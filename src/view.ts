/**
 * Presentation layer — everything about drawing the frame lives here.
 *
 * The screen is composed bottom-up: the chat log viewport (all rows above the
 * input bar), the input bar (prompt marker + text + cursor), and a status
 * line (model, connection/session state). `render()` turns plain UI state
 * into one styled frame string; `main.ts` writes it. No network code here.
 */
import { initLip, Lipgloss } from "charsm";

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

/** Style ids registered with charsm; referenced by name when applying. */
const S = {
  viewport: "viewport",
  userMarker: "userMarker",
  assistantMarker: "assistantMarker",
  user: "user",
  assistant: "assistant",
  tool: "tool",
  system: "system",
  error: "error",
  chunk: "chunk",
  chunkHeader: "chunkHeader",
  chunkHeaderFocus: "chunkHeaderFocus",
  chunkMore: "chunkMore",
  promptMarker: "promptMarker",
  inputText: "inputText",
  cursor: "cursor",
  status: "status",
} as const;

let lip: Lipgloss | undefined;
let stylesReady = false;

/** Initialize the charsm WASM runtime. Throws a friendly error on failure. */
export async function initLipGloss(): Promise<void> {
  if (stylesReady) return;
  let ok = false;
  try {
    ok = await initLip();
  } catch (err) {
    throw new Error(
      `failed to load the charsm styling engine: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!ok) {
    throw new Error("failed to load the charsm styling engine (initLip returned false)");
  }
  lip = new Lipgloss();
  defineStyles();
  stylesReady = true;
}

/** Register every style used by the frame. Called once after init. */
function defineStyles(): void {
  const l = lip;
  if (!l) return;
  l.createStyle({ id: S.viewport, margin: [0] });
  l.createStyle({ id: S.userMarker, margin: [0], bold: true, canvasColor: { color: "#22c55e" } });
  l.createStyle({
    id: S.assistantMarker,
    margin: [0],
    bold: true,
    canvasColor: { color: "#38bdf8" },
  });
  l.createStyle({ id: S.user, margin: [0], canvasColor: { color: "#e2e8f0" } });
  l.createStyle({ id: S.assistant, margin: [0] });
  l.createStyle({ id: S.tool, margin: [0], canvasColor: { color: "#a78bfa" } });
  l.createStyle({ id: S.system, margin: [0], canvasColor: { color: "#94a3b8" } });
  l.createStyle({ id: S.error, margin: [0], bold: true, canvasColor: { color: "#ef4444" } });
  l.createStyle({ id: S.promptMarker, margin: [0], bold: true, canvasColor: { color: "#a78bfa" } });
  l.createStyle({ id: S.inputText, margin: [0] });
  l.createStyle({
    id: S.cursor,
    margin: [0],
    bold: true,
    canvasColor: { background: "#7c3aed", color: "#ffffff" },
  });
  l.createStyle({ id: S.status, margin: [0], canvasColor: { color: "#64748b" } });
  l.createStyle({ id: S.chunk, margin: [0], canvasColor: { color: "#cbd5e1" } });
  l.createStyle({ id: S.chunkHeader, margin: [0], bold: true, canvasColor: { color: "#7dd3fc" } });
  l.createStyle({
    id: S.chunkHeaderFocus,
    margin: [0],
    bold: true,
    canvasColor: { background: "#1e293b", color: "#e2e8f0" },
  });
  l.createStyle({ id: S.chunkMore, margin: [0], canvasColor: { color: "#f59e0b" } });
}

/** Assert the engine is initialized (guards render before init). */
function engine(): Lipgloss {
  if (!lip) throw new Error("render() called before initLipGloss()");
  return lip;
}

/** Width of a string in terminal cells, ignoring ANSI escape sequences. */
export function displayWidth(text: string): number {
  return stripAnsi(text).length;
}

/** Remove ANSI escape sequences (CSI, OSC, single-character escapes). */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "");
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
  if (max <= 0) return "";
  let out = "";
  let width = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === "\x1b") {
      const esc = matchEscape(text.slice(i));
      if (esc) {
        out += esc;
        i += esc.length;
        continue;
      }
      i += 1;
      continue;
    }
    if (width >= max) break;
    out += ch;
    width += 1;
    i += 1;
  }
  return out;
}

/**
 * Word-wrap one paragraph to `cols`, then hard-truncate any single overlong
 * token so no rendered line ever exceeds the terminal width.
 */
export function wrapText(text: string, cols: number): string[] {
  if (cols < 1) return [""];
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of raw.split(" ")) {
      if (word === "") {
        line += " ";
        continue;
      }
      if (line === "") {
        line = word;
      } else if (line.length + 1 + word.length <= cols) {
        line = `${line} ${word}`;
      } else {
        out.push(line);
        line = word;
      }
      // Hard-truncate a token that cannot fit on a line of its own.
      while (line.length > cols) {
        out.push(line.slice(0, cols));
        line = line.slice(cols);
      }
    }
    out.push(line);
  }
  return out;
}

/** Style id for an entry kind. */
function kindStyle(kind: EntryKind): string {
  switch (kind) {
    case "user":
      return S.user;
    case "assistant":
      return S.assistant;
    case "tool":
      return S.tool;
    case "system":
      return S.system;
    case "error":
      return S.error;
    case "chunk":
      return S.chunk;
  }
}

/** Marker rendered in front of the first line of an entry. */
function markerFor(kind: EntryKind): { text: string; style: string } | undefined {
  switch (kind) {
    case "user":
      return { text: "you \u203a ", style: S.userMarker };
    case "assistant":
      return { text: "yog \u203a ", style: S.assistantMarker };
    default:
      return undefined;
  }
}

/** Marker width in cells ("you › " / "yog › "). */
const MARKER_WIDTH = 5;

/** Rows each collapsed chunk preview shows (label excluded). */
const COLLAPSE_LINES = 6;

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
 * Render text/JSON with glamour syntax highlighting (charsm `RenderMD`), then
 * normalize it to the terminal width: drop glamour's blank outer lines and
 * shared indent, cap every line. Returns undefined on failure or oversized
 * input so callers can fall back to plain text.
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
    const rendered = engine().RenderMD(`\`\`\`${lang}\n${text}\n\`\`\``, "tokyo-night");
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
 * Rows for a tool-result chunk body. The bash tool's shape (stdout/stderr/
 * exitCode) is rendered as real text — never the JSON-escaped blob; anything
 * else is syntax-highlighted JSON, falling back to plain wrapped lines.
 * Returns undefined when there is nothing worth showing.
 */
export function resultPreview(result: unknown, cols: number): string[] | undefined {
  const target = Math.max(1, cols - 2);
  const CAP = 500;

  // bash-shaped result: stdout/stderr as text + an exit-status line.
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>;
    const out = obj["stdout"];
    const err = obj["stderr"];
    if (typeof out === "string" || typeof err === "string") {
      const exit = typeof obj["exitCode"] === "number" ? `exit ${obj["exitCode"]}` : "exit ?";
      const runtime = typeof obj["runtimeMs"] === "number" ? ` · ${obj["runtimeMs"]}ms` : "";
      const rows: string[] = [`${exit}${runtime}`];
      for (const chunk of [out, err]) {
        if (typeof chunk !== "string" || chunk.trim() === "") continue;
        const body = chunk.replace(/\n$/, "").split("\n");
        for (const line of body) {
          if (rows.length >= CAP) break;
          rows.push(...wrapText(line, target));
        }
      }
      return rows; // even stdout/stderr-less: status line is still useful
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

/**
 * The display rows of one entry before wrapping: label first, then content.
 * Chunk content arrives pre-styled and width-capped (from `highlightJson` or
 * plain output lines) and passes through unwrapped; collapsed chunks show a
 * bounded preview plus a "+N lines" hint.
 */
function entryLogical(entry: LogEntry, cols: number): string[] {
  if (entry.kind === "chunk") {
    const rows: string[] = [entry.lines[0] ?? ""];
    const body = entry.lines.slice(1);
    if (entry.collapsed) {
      const preview = body.slice(0, COLLAPSE_LINES);
      rows.push(...preview);
      const hidden = body.length - preview.length;
      if (hidden > 0) {
        const hint = `… +${hidden} line${hidden === 1 ? "" : "s"} (focus, Enter)`;
        rows.push(engine().apply({ value: hint, id: S.chunkMore }));
      }
    } else {
      rows.push(...body);
    }
    return rows;
  }
  const out: string[] = [];
  for (const line of entry.lines) out.push(...wrapText(line, cols));
  return out.length > 0 ? out : [""];
}

/**
 * Build the visible log viewport: resolve each entry to rows (wrapping
 * plain entries, passing pre-styled chunk content through), prefix markers,
 * highlight the focused chunk header, then slice `viewportRows` rows from
 * `scrollOffset`.
 */
function buildViewport(state: RenderState): string[] {
  const l = engine();
  const logical: string[] = [];
  for (const [entryIndex, entry] of state.entries.entries()) {
    const focused = entryIndex === state.focusIndex;
    const rows = entryLogical(entry, state.cols);
    for (const [idx, row] of rows.entries()) {
      const marker = idx === 0 ? markerFor(entry.kind) : undefined;
      const bodyCols = marker ? Math.max(1, state.cols - MARKER_WIDTH) : state.cols;
      const prestyled = entry.kind === "chunk" && idx > 0;
      const wrapped = prestyled ? [row] : wrapText(row, bodyCols);
      for (const [widx, wl] of wrapped.entries()) {
        const body = wl === "" && rows.length > 1 ? " " : wl;
        if (widx === 0 && marker) {
          const m = l.apply({ value: marker.text, id: marker.style });
          logical.push(m + l.apply({ value: body, id: kindStyle(entry.kind) }));
        } else if (entry.kind === "chunk" && idx === 0) {
          logical.push(l.apply({ value: body, id: focused ? S.chunkHeaderFocus : S.chunkHeader }));
        } else if (prestyled) {
          logical.push(body);
        } else {
          const styled = l.apply({ value: body, id: kindStyle(entry.kind) });
          logical.push(entry.kind === "tool" ? colorizeToolLine(styled) : styled);
        }
      }
    }
    // Blank separator between entries.
    logical.push("");
  }

  // Visible slice from the scroll offset, padded to the viewport height.
  const start = Math.max(0, Math.min(state.scrollOffset, Math.max(0, logical.length)));
  const visible: string[] = [];
  for (let i = start; i < logical.length && visible.length < state.viewportRows; i += 1) {
    const line = logical[i] as string;
    visible.push(truncateAnsi(line, state.cols));
  }
  while (visible.length < state.viewportRows) visible.push("");
  return visible;
}

/** Number of wrapped rows the current entries occupy at `cols`. */
export function totalRows(entries: LogEntry[], cols: number): number {
  let rows = 0;
  for (const entry of entries) {
    const lines = entryLogical(entry, cols);
    for (const [idx, line] of lines.entries()) {
      const bodyCols = idx === 0 && markerFor(entry.kind) ? Math.max(1, cols - MARKER_WIDTH) : cols;
      rows += entry.kind === "chunk" && idx > 0 ? 1 : wrapText(line, bodyCols).length;
    }
    rows += 1; // separator
  }
  return rows;
}

/** Render the input bar: marker + text window with a highlighted cursor. */
function buildInput(state: RenderState): string {
  const l = engine();
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
    l.apply({ value: marker, id: S.promptMarker }),
    l.apply({ value: before, id: S.inputText }),
    at === "" ? l.apply({ value: " ", id: S.cursor }) : l.apply({ value: at, id: S.cursor }),
    l.apply({ value: truncateAnsi(after, widthAfter), id: S.inputText }),
  ];
  const line = l.join({ direction: "horizontal", position: "left", elements: parts });
  return truncateAnsi(line, state.cols);
}

/** Compose the whole frame: viewport + input bar + status line. */
export function render(state: RenderState): string {
  const l = engine();
  const rows = Math.max(1, state.viewportRows);
  const viewportLines = buildViewport({ ...state, viewportRows: rows });
  const viewport = l.apply({ value: viewportLines.join("\n"), id: S.viewport });
  const input = buildInput(state);
  const status = l.apply({ value: state.status, id: S.status });

  const frame = l.join({
    direction: "vertical",
    position: "top",
    elements: [viewport, input, status],
  });
  // Normalize every line to the terminal width so auto-wrap never shifts the
  // frame (the join pads width-aware; this trims overset lines).
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