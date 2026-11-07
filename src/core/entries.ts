/**
 * The chat-log entry model — the domain shape shared by the presenter
 * (which builds entries) and the renderer (which draws them).
 *
 * It lives in `core/` so the domain never imports the presentation layer:
 * `core` owns the shape of a log entry, `ui/` owns how it looks.
 */

/** Kinds of log entry the client can display. */
export type EntryKind =
  | "user"
  | "assistant"
  | "tool"
  | "toolResult"
  | "system"
  | "error"
  | "chunk"
  | "notice"
  | "status"
  | "debug";

/**
 * Per-table interaction state: whether the table is expanded and how far
 * it is scrolled horizontally.
 *
 * The state is keyed by the table's index *within its entry*, so two tables
 * in one entry expand and scroll independently — the focus ring addresses
 * tables, so the state must live at table granularity.
 */
export interface TableState {
  /** True when the table renders in its expanded (wider) layout. */
  expanded?: boolean;
  /** Horizontal scroll offset, in cells. */
  scrollX: number;
}

/** One entry in the chat log (logical lines, before wrapping). */
export interface LogEntry {
  kind: EntryKind;
  lines: string[];
  /** True while this entry is still receiving streamed content. */
  streaming?: boolean;
  /** Collapsible block: lines[0] is a label, lines[1..] are the body
   *  (tool output chunks). Collapsed shows a bounded preview; focus +
   *  Enter expands to the full content. */
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
  /** Raw tool result of a chunk entry. The renderer expands it to display
   *  rows at the current width — the domain never formats it. */
  result?: unknown;
  /** Token-count note for this call's results (`172t`, `+1.2Kt`): chunk and
   *  toolResult entries carry it on their header/collapsed line, and the
   *  renderer repeats it below expanded content on its own row. Never set on
   *  a tool-call entry — the count describes RESULTS, so it must never read
   *  as a later call's args-row figure. */
  tokenNote?: string;
  /** Per-table state, keyed by the table's index within the entry. */
  tables?: Record<number, TableState>;
}

/**
 * The mutable per-table state of `index`, created on first use.
 *
 * Mutating the returned object in place is the intended way to change a
 * table's expansion or scroll offset — the store shares the entry objects
 * with the renderer, which reads the state while drawing.
 */
/**
 * The existing state of the table at `index`, or a default when it has none.
 *
 * Reading the state must not create it — a table that never scrolls never
 * grows a state entry.
 */
export function tableStateOf(entry: LogEntry, index: number): TableState {
  return entry.tables?.[index] ?? { scrollX: 0 };
}

/**
 * The mutable per-table state of `index`, created on first use.
 *
 * Mutating the returned object in place is the intended way to change a
 * table's expansion or scroll offset — the store shares the entry objects
 * with the renderer, which reads the state while drawing.
 */
export function tableState(entry: LogEntry, index: number): TableState {
  const tables = (entry.tables ??= {});
  const existing = tables[index];
  if (existing !== undefined) return existing;
  const created: TableState = { scrollX: 0 };
  tables[index] = created;
  return created;
}
