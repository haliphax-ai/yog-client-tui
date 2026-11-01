/** Focus ring over focusable log entries — pure, terminal-free.
 *
 * Tab / Shift-Tab move focus forward (+1) or backward (-1) through the
 * focusable entry indices. The ring wraps through the "nothing selected"
 * state (-1): past the last entry lands on none (as does Shift-Tab from
 * the first), and the next press continues from that end.
 *
 * A prose entry may carry more than one GFM table. Each table is an
 * independent focusable unit, so the ring is a flat list of targets:
 * chunk/tool entries are `{entry, table: -1}` and every table inside a
 * prose entry is `{entry, table: ti}`. Tab walks through tables inside an
 * entry before moving on to the next entry.
 */

/** No focused entry. */
export const FOCUS_NONE = -1;

/** A focus target: entry index + table index within that entry. */
export type FocusTarget = { entry: number; table: number };

/** The "nothing focused" target. */
export const FOCUS_NONE_TARGET: FocusTarget = { entry: FOCUS_NONE, table: FOCUS_NONE };

/** True when a prose entry contains a GFM table: parsed with the same
 *  splitting the entry renderer uses, so a table-shaped section is exactly
 *  what will render as a table. Terminal-free and cheap (a line scan). */
export function isProseTable(
  entry: { kind: string; lines?: readonly string[] },
  parse: (text: string) => unknown,
): boolean {
  if (entry.kind !== "user" && entry.kind !== "assistant") return false;
  return parse((entry.lines ?? []).join("\n")) !== null;
}

/** Number of GFM tables in a prose entry's text (0 for non-prose). */
export function tableCount(
  entry: { kind: string; lines?: readonly string[] },
  split: (text: string) => { kind: string }[],
): number {
  if (entry.kind !== "user" && entry.kind !== "assistant") return 0;
  return split((entry.lines ?? []).join("\n")).filter((s) => s.kind === "table").length;
}

/** Indices of focusable entries (tool calls, output chunks, prose+table). */
export function focusableChunks(
  entries: readonly { kind: string; lines?: readonly string[] }[],
  focusable: readonly string[] = ["chunk", "tool"],
  isProseTableFn?: (e: { kind: string; lines?: readonly string[] }) => boolean,
): number[] {
  return entries.flatMap((e, i) =>
    focusable.includes(e.kind) || (isProseTableFn !== undefined && isProseTableFn(e)) ? [i] : [],
  );
}

/**
 * Build the flat focus ring: every focusable unit in order.
 *
 * Chunk/tool entries contribute one target (`table: -1`). A prose entry
 * carrying N tables contributes N targets (`table: 0..N-1`). Entries with
 * no tables and not chunk/tool are skipped.
 */
export function focusRing(
  entries: readonly { kind: string; lines?: readonly string[] }[],
  focusable: readonly string[] = ["chunk", "tool"],
  isProseTableFn?: (e: { kind: string; lines?: readonly string[] }) => boolean,
  tableCountFn?: (e: { kind: string; lines?: readonly string[] }) => number,
): FocusTarget[] {
  const ring: FocusTarget[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (focusable.includes(e.kind)) {
      ring.push({ entry: i, table: FOCUS_NONE });
    } else if (isProseTableFn !== undefined && isProseTableFn(e)) {
      const n = tableCountFn !== undefined ? tableCountFn(e) : 1;
      for (let t = 0; t < n; t++) ring.push({ entry: i, table: t });
    }
  }
  return ring;
}

/** Next focus target after pressing Tab (+1) or Shift-Tab (-1).
 *
 * When nothing is focused, the ring enters from the nearest end (first
 * chunk going forward, last chunk going backward). With no focusable
 * units it stays at none.
 */
export function moveFocus(
  entries: readonly { kind: string; lines?: readonly string[] }[],
  current: FocusTarget,
  dir: 1 | -1,
  isProseTableFn?: (e: { kind: string; lines?: readonly string[] }) => boolean,
  tableCountFn?: (e: { kind: string; lines?: readonly string[] }) => number,
): FocusTarget {
  const ring = focusRing(entries, ["chunk", "tool"], isProseTableFn, tableCountFn);
  if (ring.length === 0) return FOCUS_NONE_TARGET;
  const idx = ring.findIndex((t) => t.entry === current.entry && t.table === current.table);
  if (idx === -1)
    return dir === 1 ? (ring[0] as FocusTarget) : (ring[ring.length - 1] as FocusTarget);
  if (dir === 1)
    return idx === ring.length - 1 ? FOCUS_NONE_TARGET : (ring[idx + 1] as FocusTarget);
  return idx === 0 ? FOCUS_NONE_TARGET : (ring[idx - 1] as FocusTarget);
}
