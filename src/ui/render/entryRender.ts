/** A fully styled entry: its rendered rows, their count, and the row offset
 *  of every table section within the rendered block (0-based, relative to
 *  the entry's first row). Used by `revealFocus` to scroll a focused table
 *  — not just the entry that contains it — into the viewport. */
export interface EntryRender {
  rendered: string;
  rows: number;
  tableOffsets: number[];
}
