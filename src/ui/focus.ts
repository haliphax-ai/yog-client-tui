/**
 * Focus-ring view of the entries: which units the ring can visit, in
 * document order.
 *
 * This is interaction state, not rendering: the ring walks `FocusTarget`s,
 * and the renderer never consumes them. The unit list is derived from the
 * same sections the renderer draws (entrySections), so every table that
 * renders is a table that can be focused — but nothing here touches row
 * output, the row cache, or the render layer's public surface.
 */
import type { EntryKind, LogEntry } from "../core/index.ts";
import type { FocusTarget } from "../core/index.ts";
import { sectionsOf } from "./render/index.ts";

/** Entry kinds that contribute a focus target of their own (not counting
 *  the tables inside a prose entry — those walk after the entry unit). */
const FOCUSABLE_KINDS: ReadonlySet<EntryKind> = new Set([
  "chunk",
  "tool",
  "toolResult",
  "debug",
  "user",
  "assistant",
]);

/**
 * The focusable units of the given entries, in document order.
 *
 * A chunk, tool, user, or assistant entry contributes one unit
 * (`{entry, table: -1}`); a prose entry with N tables contributes N table
 * units (`{entry, table: 0..N-1}`) IN ADDITION to the entry itself. The
 * entry unit comes first, then its tables — Tab walks a prose entry's
 * tables after selecting the entry, mirroring the document order.
 *
 * The units come from the same sections the renderer draws, so every table
 * that renders is a table that can be focused.
 */
export function focusUnits(entries: readonly LogEntry[]): FocusTarget[] {
  const units: FocusTarget[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as LogEntry;
    if (FOCUSABLE_KINDS.has(entry.kind)) units.push({ entry: i, table: -1 });
    let table = 0;
    for (const section of sectionsOf(entry)) {
      if (section.kind === "table") {
        units.push({ entry: i, table });
        table += 1;
      }
    }
  }
  return units;
}
