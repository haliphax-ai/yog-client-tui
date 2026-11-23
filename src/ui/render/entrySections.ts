/**
 * The cached prose/table split of a prose entry.
 *
 * This is the single source of truth about which parts of an entry are
 * tables: the renderer draws the table sections, the focus ring walks the
 * same sections, and the scroll bounds measure the same sections. They
 * cannot disagree.
 */
import { splitTableSections } from "./table/index.ts";
import type { TableSection } from "./table/index.ts";
import type { LogEntry } from "../../core/index.ts";

export type { TableSection };

/** The cached prose/table split of one entry. */
interface SectionCache {
  contentKey: string;
  sections: TableSection[];
}

const sectionCaches = new WeakMap<LogEntry, SectionCache>();

/**
 * O(1) content signature: line count + first/last line lengths cover every
 * mutation this codebase performs (append rows, grow last row, amend label,
 * set the token note) — tool-call entries never mutate an existing line to
 * a different length in place.
 */
export function contentKeyOf(entry: LogEntry): string {
  const lines = entry.lines;
  return `${lines.length}|${lines[0]?.length ?? 0}|${lines[lines.length - 1]?.length ?? 0}`;
}

/**
 * The entry's prose/table sections, parsed once per content change.
 */
export function sectionsOf(entry: LogEntry): TableSection[] {
  if (entry.kind !== "user" && entry.kind !== "assistant") return [];
  const contentKey = contentKeyOf(entry);
  const hit = sectionCaches.get(entry);
  if (hit !== undefined && hit.contentKey === contentKey) return hit.sections;
  const sections = splitTableSections(entry.lines.join("\n"));
  sectionCaches.set(entry, { contentKey, sections });
  return sections;
}
