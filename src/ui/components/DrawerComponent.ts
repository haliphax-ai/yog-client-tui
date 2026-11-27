/**
 * Drawer: a generic padded container between the chat log and the text input.
 *
 * The drawer knows nothing about what it contains. Children are whatever has
 * registered via `registerDrawerChild` (in registration order); each child is
 * an ordinary component that renders itself — including rendering nothing
 * (`[]` / `""`) when it has nothing to say. When every registered child
 * renders nothing, the drawer is fully collapsed: zero rows, contributing
 * nothing to the frame.
 *
 * When visible, the drawer is displayed with horizontal and vertical padding
 * of 1 cell on every side (plan of record). Children render into the padded
 * interior (width minus 2 cells); their rows are truncated to that interior
 * so the padding style never word-wraps a child into extra rows.
 *
 * No keys, no focus — children handle themselves; the drawer only frames them.
 */
import { BaseComponent, type RenderContext } from "./Component.ts";
import { registeredDrawerChildren } from "./drawerRegistry.ts";
import { truncateAnsi } from "../../util/index.ts";
import { ST } from "../theme.ts";

/** Normalize a component render result into rows ("" renders nothing). */
function toRows(result: string | string[]): string[] {
  if (Array.isArray(result)) return result;
  return result === "" ? [] : result.split("\n");
}

export class DrawerComponent extends BaseComponent {
  constructor() {
    super(false);
  }

  /**
   * One padded block holding every child's rows, or no rows at all when
   * nothing registered renders anything (fully collapsed).
   *
   * A child may RETAIN its height while idle by rendering a blank row
   * (the busy spinner's #145 contract): those rows count as content for
   * the framing rules below — separators and the input-side gap — so the
   * drawer's row count never changes on a child's show/hide edge.
   */
  override render(ctx: RenderContext): string[] {
    const cols = Math.max(0, Math.floor(ctx.cols));
    const inner = Math.max(0, cols - 2);
    const rows: string[] = [];
    let lastHadRows = false;
    for (const child of registeredDrawerChildren()) {
      const childRows = toRows(child.render({ cols: inner }));
      // One blank row between drawer items (the spinner and the jobs
      // table must not butt together); never leading or trailing.
      if (childRows.length > 0 && lastHadRows) rows.push("");
      for (const row of childRows) {
        rows.push(truncateAnsi(row, inner));
      }
      lastHadRows = childRows.length > 0;
    }
    if (rows.length === 0) return [];
    // The gap on the INPUT side: one blank row after the block (the log's
    // trailing separator blank is the gap on the LOG side). This keeps
    // exactly one blank between log | drawer | input in every state.
    rows.push("");
    return ST.drawer.width(cols).render(rows.join("\n")).split("\n");
  }
  /** Row count of the padded block (0 when fully collapsed). */
  override measure(width: number): number {
    const cols = Math.max(0, Math.floor(width));
    return this.render({ cols }).length;
  }
}
