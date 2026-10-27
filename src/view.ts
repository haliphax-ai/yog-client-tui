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
export type EntryKind = "user" | "assistant" | "tool" | "system" | "error";

/** One entry in the chat log (logical lines, before wrapping). */
export interface LogEntry {
  kind: EntryKind;
  lines: string[];
  /** True while this entry is still receiving streamed content. */
  streaming?: boolean;
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

/**
 * Build the visible log viewport: wrap every entry to the terminal width,
 * prefix markers on first lines, take `viewportRows` rows from
 * `scrollOffset`.
 */
function buildViewport(state: RenderState): string[] {
  const l = engine();
  const logical: string[] = [];
  for (const entry of state.entries) {
    for (const [idx, line] of entry.lines.entries()) {
      const marker = idx === 0 ? markerFor(entry.kind) : undefined;
      const bodyCols = marker ? Math.max(1, state.cols - MARKER_WIDTH) : state.cols;
      const wrapped = wrapText(line, bodyCols);
      for (const [widx, wl] of wrapped.entries()) {
        const body = wl === "" && entry.lines.length > 1 ? " " : wl;
        if (widx === 0 && marker) {
          const m = l.apply({ value: marker.text, id: marker.style });
          logical.push(m + l.apply({ value: body, id: kindStyle(entry.kind) }));
        } else {
          logical.push(l.apply({ value: body, id: kindStyle(entry.kind) }));
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
    for (const [idx, line] of entry.lines.entries()) {
      const bodyCols = idx === 0 && markerFor(entry.kind) ? Math.max(1, cols - MARKER_WIDTH) : cols;
      rows += wrapText(line, bodyCols).length;
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