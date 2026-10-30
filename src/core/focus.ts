/**
 * Focus ring over expandable log entries — pure, terminal-free.
 *
 * Tab / Shift-Tab move focus forward (+1) or backward (-1) through the
 * focusable entry indices. The ring wraps through the "nothing selected"
 * state (-1): past the last entry lands on none (as does Shift-Tab from
 * the first), and the next press continues from that end.
 */

/** No focused entry. */
export const FOCUS_NONE = -1;

/**
 * True when a prose entry contains a GFM table: parsed with the same
 * splitting the entry renderer uses, so a table-shaped section is exactly
 * what will render as a table. Terminal-free and cheap (a line scan).
 */
export function isProseTable(
  entry: { kind: string; lines?: readonly string[] },
  parse: (text: string) => unknown,
): boolean {
  if (entry.kind !== "user" && entry.kind !== "assistant") return false;
  return parse((entry.lines ?? []).join("\n")) !== null;
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
 * Next focus index after pressing Tab (+1) or Shift-Tab (-1).
 *
 * When nothing is focused, the ring enters from the nearest end (first
 * chunk going forward, last chunk going backward). With no focusable
 * entries it stays at none.
 */
export function moveFocus(
  entries: readonly { kind: string; lines?: readonly string[] }[],
  current: number,
  dir: 1 | -1,
  isProseTableFn?: (e: { kind: string; lines?: readonly string[] }) => boolean,
): number {
  const targets = focusableChunks(entries, ["chunk", "tool"], isProseTableFn);
  if (targets.length === 0) return FOCUS_NONE;
  const pos = targets.indexOf(current);
  if (pos === -1)
    return dir === 1 ? (targets[0] as number) : (targets[targets.length - 1] as number);
  if (dir === 1) return pos === targets.length - 1 ? FOCUS_NONE : (targets[pos + 1] as number);
  return pos === 0 ? FOCUS_NONE : (targets[pos - 1] as number);
}
