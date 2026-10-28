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
  /** Memoized rendered rows (internal — do not mutate from outside the render domain). */
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