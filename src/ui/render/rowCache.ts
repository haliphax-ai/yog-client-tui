/**
 * The memoized row cache: rendered rows per `LogEntry` object, keyed on
 * everything the renderer derives output from.
 *
 * A matching key means a byte-identical render — safe to reuse. A cache
 * hit performs no table parse and no width measurement: the prose/table
 * split is cached separately (see entrySections.ts, keyed by the content
 * signature).
 */
import { renderNotice, renderStatus } from "./notices.ts";
import { renderChunkLike, renderToolBlock } from "./blocks.ts";
import { renderProseEntry } from "./proseEntry.ts";
import { renderPlainEntry } from "./plain.ts";
import { contentKeyOf } from "./entrySections.ts";
import { kindStyle } from "./entryStyle.ts";
import type { EntryRender } from "./entryRender.ts";
import type { EntryKind, LogEntry } from "../../core/entries.ts";

/** The cached rendered rows of one entry. */
export interface RowCache {
  key: string;
  rows: string[];
  tableOffsets: number[];
}

const rowCaches = new WeakMap<LogEntry, RowCache>();

/** Monotonic row-cache version: bumped on every render miss so cached
 *  height summaries can detect staleness in O(1). */
let revision = 0;

/** The current row-cache revision (used by height summaries). */
export function rowCacheRevision(): number {
  return revision;
}

/**
 * Render signature for the row cache: everything the renderer derives
 * output from — display width, the focus flag, the collapse/expand
 * toggles, the content signature (streaming entries mutate `lines`, tool
 * calls get `label`/`lines[0]` amended when the result lands), and the
 * per-table state (expansion and scroll offset).
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
  const flags = [focused, entry.collapsed, entry.expanded].map((f) => (f ? 1 : 0));
  return [
    cols,
    focusedTableIndex,
    ...flags,
    contentKeyOf(entry),
    entry.label ?? "",
    entry.argsCompact?.length ?? 0,
    entry.full?.length ?? 0,
    entry.tokenNote ?? "",
    tableState,
  ].join("|");
}

/** The per-kind renderer lookup: prose, chunk, tool, notice (and error),
 *  status. The plain wrapper covers every kind without a bespoke
 *  renderer. */
type EntryRenderer = (
  entry: LogEntry,
  cols: number,
  focusedTable: boolean,
  focusedTableIndex: number,
) => EntryRender;

const RENDERER_BY_KIND: Partial<Record<EntryKind, EntryRenderer>> = {
  user: renderProseEntry,
  assistant: renderProseEntry,
  chunk: renderChunkLike,
  debug: renderChunkLike,
  tool: renderToolBlock,
  toolResult: renderToolBlock,
  notice: renderNotice,
  error: renderNotice,
  status: renderStatus,
};

/**
 * Render one entry to its styled block at `cols`, dispatching to the
 * per-kind renderer in the table above; every kind without a bespoke
 * renderer falls back to the plain wrapper.
 */
function renderEntry(
  entry: LogEntry,
  cols: number,
  focusedTable = false,
  focusedTableIndex = -1,
): EntryRender {
  const renderer: EntryRenderer | undefined = RENDERER_BY_KIND[entry.kind];
  if (renderer === undefined) return renderPlainEntry(entry, cols, kindStyle(entry.kind));
  return renderer(entry, cols, focusedTable, focusedTableIndex);
}

/**
 * Rendered rows for one entry, memoized on the `LogEntry` object. The key
 * captures everything the renderer derives output from (see
 * {@link renderKeyOf}); a matching key means a byte-identical render — safe
 * to reuse.
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

/** The cached rendered rows of an entry, if it has been rendered. */
export function cacheOf(entry: LogEntry): RowCache | undefined {
  return rowCaches.get(entry);
}

/** Row offsets of every table section inside an entry's rendered block.
 *  Returns `undefined` for entries that carry no table (or whose cache
 *  hasn't been populated yet). Used by `revealFocus` to scroll a focused
 *  table — not just the entry that contains it — into the viewport. */
export function tableOffsetsOf(entry: LogEntry): number[] | undefined {
  return rowCaches.get(entry)?.tableOffsets;
}

/** Record a direct entry mutation: evict its cached rows and bump the
 *  revision, so height summaries rebuild on the next query. Components call
 *  this when they mutate an entry outside a render pass (e.g. toggles,
 *  appends, token notes) that the row cache would otherwise not observe. */
export function noteMutation(entry?: LogEntry): void {
  if (entry !== undefined) rowCaches.delete(entry);
  revision += 1;
}
