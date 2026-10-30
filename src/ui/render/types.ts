export type EntryKind = "user" | "assistant" | "tool" | "system" | "error" | "chunk" | "notice";

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
