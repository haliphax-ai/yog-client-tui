/**
 * Height accounting for the entries array: per-entry cached rows and the
 * cached (tops/total) summary backing viewport anchoring.
 *
 * Backed by a cached summary per (entries array identity, cols): the total
 * is reused verbatim while the row-cache revision is unchanged —
 * steady-state frames pay O(1) here instead of re-counting every row.
 */
import { cheapHeight } from "./cheapHeight.ts";
import { cachedRows, rowCacheRevision } from "./rowCache.ts";
import type { LogEntry } from "../../core/entries.ts";

/** Cached aggregate height data for one entries array at one width. */
export interface HeightSummary {
  cols: number;
  /** `revision` when this summary was built; mismatch means rebuild. */
  revision: number;
  /** Number of entries the summary covers (append guard). */
  length: number;
  /** Total TERMINAL rows (incl. separators). Exact when `partial` is false. */
  total: number;
  /** tops[i] = terminal row where entry i begins (incl. prior separators). */
  tops: number[];
  /**
   * Anchor-outward summary (#67): reserved for partial summaries.
   * The current anchored builder is exact, so this is false in
   * practice; the fields are kept so a future window-only builder
   * can mark [filledLow, filledHigh] as the exact span.
   */
  partial?: boolean;
  /** First entry index with an exact height (partial summaries only). */
  filledLow?: number;
  /** Last entry index with an exact height, inclusive (partial only). */
  filledHigh?: number;
}

const heightSummaries = new WeakMap<LogEntry[], HeightSummary>();

/**
 * Number of TERMINAL rows the given entries occupy at `cols` (incl.
 * separators). Rows are hard-wrapped to the terminal width, so each row
 * occupies exactly one terminal row.
 */
export function heightSummaryOf(entries: LogEntry[], cols: number): HeightSummary {
  const revision = rowCacheRevision();
  const cached = heightSummaries.get(entries);
  if (summaryFresh(cached, entries, cols, revision)) return cached as HeightSummary;
  return buildTopDownSummary(entries, cols, revision);
}

/** True when the cached summary still describes this entries array at
 *  `cols`, freshly built at `revision` (partial summaries never satisfy
 *  the anchored caller). */
function summaryFresh(
  cached: HeightSummary | undefined,
  entries: LogEntry[],
  cols: number,
  revision: number,
  requireFull = true,
): boolean {
  if (cached === undefined) return false;
  if (cached.cols !== cols) return false;
  if (cached.revision !== revision) return false;
  if (cached.length !== entries.length) return false;
  return !(requireFull && cached.partial === true);
}

/**
 * Anchor-outward height summary (#67): the visible region materializes
 * first. `anchor` is the entry index the viewport is anchored on (the
 * last entry in follow mode, the entry containing the first visible
 * row otherwise); heights are filled from the anchor outward (up and
 * down simultaneously, one step at a time) so the window's glamour
 * runs before the far head's. The summary is exact for every entry —
 * order, not approximation, is the win here, plus cheap exact heights
 * for placeholders/system rows (see `cheapHeight`).
 */
export function heightSummaryAnchored(
  entries: LogEntry[],
  cols: number,
  anchor: number,
  _windowRows: number = 48,
  _rev: number = rowCacheRevision(),
): HeightSummary {
  const cached = heightSummaries.get(entries);
  if (summaryFresh(cached, entries, cols, _rev)) return cached as HeightSummary;
  const n = entries.length;
  if (n === 0) return emptySummary(entries, cols, _rev);
  return anchoredSummary(entries, cols, anchor, n, _rev);
}

/** The empty log's summary: zero rows, one top boundary. */
function emptySummary(entries: LogEntry[], cols: number, revision: number): HeightSummary {
  const summary: HeightSummary = {
    cols,
    revision,
    length: 0,
    total: 0,
    tops: [0],
    partial: false,
    filledLow: 0,
    filledHigh: -1,
  };
  heightSummaries.set(entries, summary);
  return summary;
}

/** The exact anchor-outward fill (#67): start at the anchor entry (the
 *  chunk closest to the top of the viewport, or the last entry in follow
 *  mode) and expand up/down simultaneously, one step at a time. Heights
 *  are exact for every entry; the *order* is what matters — the visible
 *  region's glamour runs first, so if a caller renders only the window
 *  after this call the window is already warm, and a background filler
 *  that walks outward will hit cache for the window first. Placeholder
 *  entries cost O(1) (cheapHeight exact), so a placeholder-first log's
 *  exact total is O(N) cheap + O(window) glamour, not O(N) glamour. */
function anchoredSummary(
  entries: LogEntry[],
  cols: number,
  anchor: number,
  n: number,
  revision: number,
): HeightSummary {
  const a = Math.max(0, Math.min(n - 1, anchor));
  const heights = Array.from({ length: n }, () => 0);
  const fill = (i: number): void => {
    const cheap = cheapHeight(entries[i] as LogEntry, cols);
    heights[i] = cheap !== -1 ? cheap : cachedRows(entries[i] as LogEntry, cols).length + 1;
  };
  fill(a);
  walkOutward(n, a, fill);
  return recordSummary(entries, topsOf(heights), n, cols, revision);
}

/** Visit every index from `a` outward, alternating down/up, so the entries
 *  around the anchor materialize before the far head. */
function walkOutward(n: number, a: number, fill: (i: number) => void): void {
  let low = a;
  let high = a;
  let down = true;
  while (low > 0 || high < n - 1) {
    if (down && high < n - 1) {
      high += 1;
      fill(high);
    } else if (!down && low > 0) {
      low -= 1;
      fill(low);
    } else if (high < n - 1) {
      high += 1;
      fill(high);
    } else if (low > 0) {
      low -= 1;
      fill(low);
    }
    down = !down;
  }
}

/** Full top-down pass retained for non-anchored callers; anchored callers
 *  use heightSummaryAnchored so the far head is never glamoured first. */
function buildTopDownSummary(entries: LogEntry[], cols: number, revision: number): HeightSummary {
  const heights = entries.map((entry) => cachedRows(entry, cols).length + 1);
  return recordSummary(entries, topsOf(heights), entries.length, cols, revision);
}

/** Prefix-sum the heights into `tops` (tops[i] = row where entry i begins). */
function topsOf(heights: number[]): number[] {
  const tops = Array.from({ length: heights.length + 1 }, () => 0);
  let total = 0;
  for (const [i, h] of heights.entries()) {
    total += h;
    tops[i + 1] = total;
  }
  return tops;
}

/** Cache and return the summary for a full (non-partial) fill. */
function recordSummary(
  entries: LogEntry[],
  tops: number[],
  n: number,
  cols: number,
  revision: number,
): HeightSummary {
  const summary: HeightSummary = {
    cols,
    revision,
    length: n,
    total: tops[n] as number,
    tops,
    partial: false,
    filledLow: 0,
    filledHigh: n - 1,
  };
  heightSummaries.set(entries, summary);
  return summary;
}

/**
 * Entry index to anchor on for a viewport whose first visible terminal
 * row is `top` (or whose follow-mode bottom is `total`): the entry whose
 * span contains `top`, clamped. Callers that know only the total (follow
 * mode) anchor on the last entry — the chunk the user actually sees.
 */
export function anchorEntryForRow(entries: LogEntry[], cols: number, top: number): number {
  if (entries.length === 0) return 0;
  const summary = heightSummaryOf(entries, cols);
  if (top >= summary.total) return entries.length - 1;
  let lo = 0;
  let hi = entries.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((summary.tops[mid] as number) <= top) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function totalRows(entries: LogEntry[], cols: number): number {
  return heightSummaryOf(entries, cols).total;
}

export { cheapHeight, estimateHeight } from "./cheapHeight.ts";
