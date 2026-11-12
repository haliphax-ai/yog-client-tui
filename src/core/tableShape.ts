/**
 * The structural shape of a parsed GFM table, mirrored for `core` (#109
 * copy semantics need to re-serialize one table to raw Markdown without
 * importing the presentation layer — `ui/render/table/parse.ts` owns the
 * real definition, and its fields are structurally identical, so the
 * type here is assignable both ways without a runtime dependency).
 *
 * Domain rule (`docs/architecture.md`): `core` never imports `ui`.
 */
/** One column: its header text, computed width (in cells), and alignment. */
export interface ParsedColumn {
  title: string;
  width: number;
  align: "left" | "center" | "right";
}

/** A parsed table: columns + rows. Rows are rectangular — every row
 *  holds exactly `columns.length` cells (GFM normalization). */
export interface ParsedTable {
  columns: ParsedColumn[];
  rows: string[][];
}
