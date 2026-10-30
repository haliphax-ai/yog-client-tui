/**
 * Focus ring over expandable log entries — pure, terminal-free.
 *
 * Tab / Shift-Tab move focus forward (+1) or backward (-1) through the
 * focusable chunk indices. The ring wraps through the "nothing selected"
 * state (-1): past the last chunk lands on none (as does Shift-Tab from
 * the first), and the next press continues from that end.
 */

/** No focused entry. */
export const FOCUS_NONE = -1;

/** Indices of focusable entries (tool calls + output chunks). */
export function focusableChunks(
  entries: readonly { kind: string }[],
  focusable: readonly string[] = ["chunk", "tool"],
): number[] {
  return entries.flatMap((e, i) => (focusable.includes(e.kind) ? [i] : []));
}

/**
 * Next focus index after pressing Tab (+1) or Shift-Tab (-1).
 *
 * When nothing is focused, the ring enters from the nearest end (first
 * chunk going forward, last chunk going backward). With no focusable
 * entries it stays at none.
 */
export function moveFocus(
  entries: readonly { kind: string }[],
  current: number,
  dir: 1 | -1,
): number {
  const targets = focusableChunks(entries);
  if (targets.length === 0) return FOCUS_NONE;
  const pos = targets.indexOf(current);
  if (pos === -1)
    return dir === 1 ? (targets[0] as number) : (targets[targets.length - 1] as number);
  if (dir === 1) return pos === targets.length - 1 ? FOCUS_NONE : (targets[pos + 1] as number);
  return pos === 0 ? FOCUS_NONE : (targets[pos - 1] as number);
}
