/**
 * The main log viewport: a `ChatLogComponent` bound to the store. The store
 * is the single source of truth — entries, scroll offset, follow mode, and
 * the entry focus ring are read via `getState()` before every mutation or
 * render and written back through `setState`, so subscribers (the render
 * scheduler) see every change.
 *
 * Focus here means two levels:
 *  1. Component focus (router order): the router offers keys to the focused
 *     component first. This component holds focus while an entry is focused.
 *  2. Entry focus (what Tab/Shift-Tab move): while an entry is focused this
 *     component claims Enter (toggle) and Esc (leave); everything else —
 *     input editing, scrolling, quit — bubbles on to the next responder and
 *     finally the global bindings.
 */
import { ChatLogComponent } from "./ChatLogComponent.ts";
import { type FocusTarget } from "../../core/focus.ts";
import { tableState, tableStateOf, type LogEntry } from "../../core/entries.ts";
import { setTopLevel } from "./keyRouter.ts";
import { getState, setState } from "../../core/store.ts";
import {
  isTableScrollSeq,
  resolveTableLayout,
  splitTableSections,
  tableRowWidth,
  tableScrollChar,
  tableScrollKey,
} from "../render/table/index.ts";

/** Shift+Down encodings — move top-level focus from the log to the input. */
const SHIFT_DOWN_SEQS: ReadonlySet<string> = new Set([
  "\x1b[1;2B", // xterm-style
  "\x1b[66;2u", // CSI-u / Kitty
]);
/**
 * Scroll geometry of the focused table at the log's width: the viewport-body
 * width and the table's total rendered width. Same `resolveTableLayout` the
 * entry renderer uses, and the SAME table (the focused one, not the first),
 * so the scroll bounds always match what is on screen.
 */
function focusedTableLayout(
  entry: LogEntry,
  tableIndex: number,
  cols: number,
): { cols: number; totalW: number } {
  const bodyW = Math.max(1, cols - 2);
  const sections = splitTableSections(entry.lines.join("\n"));
  const tables = sections.filter((s) => s.kind === "table");
  const section = tables[tableIndex];
  if (section === undefined || section.kind !== "table") return { cols: bodyW, totalW: 0 };
  const state = entry.tables?.[tableIndex];
  const layout = resolveTableLayout(
    section.table.columns.map((c) => c.width),
    bodyW,
    state?.expanded === true,
  );
  return { cols: bodyW, totalW: tableRowWidth(layout.widths) };
}

export class ChatViewport extends ChatLogComponent {
  /** Pull store state (entries, scroll, follow, focus ring) into the log. */
  private syncFromStore(): void {
    const state = getState();
    this.entries = state.entries;
    this.scrollOffset = state.scrollOffset;
    this.follow = state.follow;
    this.focusTarget = state.focusTarget;
  }

  /** Push mutations back to the store (notifies the render scheduler). */
  private commit(): void {
    setState({
      entries: this.entries,
      scrollOffset: this.scrollOffset,
      follow: this.follow,
      focusTarget: this.focusTarget,
    });
  }

  /** Rows available to this viewport in the current terminal layout. */
  private viewportHeight(): number {
    return this.viewportRows ?? 24;
  }

  /** Keep the focused entry fully visible; commit only if scroll moved. */
  private reveal(): void {
    const before = this.scrollOffset;
    const followBefore = this.follow;
    this.revealFocus(this.viewportHeight());
    if (this.scrollOffset !== before || this.follow !== followBefore) this.commit();
  }

  override render(ctx: { cols: number }): string[] {
    this.syncFromStore();
    const rows = super.render(ctx);
    // The clamp in the base render may have pinned the offset (follow mode)
    // or pulled a stale one back into range — keep the store in sync.
    const state = getState();
    if (this.scrollOffset !== state.scrollOffset || this.follow !== state.follow) {
      this.commit();
    }
    return rows;
  }

  override setFocus(target: FocusTarget): void {
    super.setFocus(target);
    this.commit();
  }

  override clearFocus(): void {
    super.clearFocus();
    this.commit();
  }

  override moveFocus(dir: 1 | -1): void {
    super.moveFocus(dir);
    this.commit();
  }

  override scrollBy(delta: number, viewportRows: number): void {
    this.syncFromStore();
    const before = this.scrollOffset;
    const followBefore = this.follow;
    super.scrollBy(delta, viewportRows);
    // A no-op scroll (already at the edge) must not schedule a frame — skip
    // the commit when the scroll changed nothing.
    if (this.scrollOffset !== before || this.follow !== followBefore) this.commit();
  }

  override jump(top: boolean, viewportRows: number): void {
    this.syncFromStore();
    super.jump(top, viewportRows);
    this.commit();
  }

  /**
   * The focused table: its entry and its index within that entry. A table
   * is only scrollable when its layout overflows the viewport — the
   * expanded layout of a squeezable table.
   */
  private focusedTable(): { entry: LogEntry; index: number } | null {
    this.syncFromStore();
    const index = this.focusTarget.table;
    if (index < 0) return null;
    const entry = this.entries[this.focusTarget.entry];
    if (entry === undefined) return null;
    if (entry.kind !== "user" && entry.kind !== "assistant") return null;
    return { entry, index };
  }

  override handleKey(seq: string): "handled" | "unhandled" {
    if (SHIFT_DOWN_SEQS.has(seq)) {
      // Shift+Down: hand the top-level ring back to the input.
      setTopLevel("input");
      setState({}); // notify the scheduler so the input un-blurs
      return "handled";
    }
    const focused = this.focusedTable();
    if (focused === null) return "unhandled";
    // Fast path: skip the expensive parse for keys that can't scroll
    // horizontally — the layout is only needed for scroll steps.
    if (!isTableScrollSeq(seq)) return "unhandled";
    const layout = focusedTableLayout(focused.entry, focused.index, this.cols);
    const step = tableScrollKey(
      seq,
      tableStateOf(focused.entry, focused.index).scrollX,
      layout.totalW,
      layout.cols,
    );
    if (step === null) return "unhandled";
    tableState(focused.entry, focused.index).scrollX = step.scrollX;
    this.commit();
    return "handled";
  }

  override handleChar(ch: string): "handled" | "unhandled" {
    if (ch === "h" || ch === "l") {
      const focused = this.focusedTable();
      if (focused === null) return "unhandled";
      const layout = focusedTableLayout(focused.entry, focused.index, this.cols);
      const step = tableScrollChar(
        ch,
        tableStateOf(focused.entry, focused.index).scrollX,
        layout.totalW,
        layout.cols,
      );
      if (step === null) return "unhandled";
      tableState(focused.entry, focused.index).scrollX = step.scrollX;
      this.commit();
      return "handled";
    }
    if (ch === "\r" || ch === "\n") {
      this.syncFromStore();
      // No focused entry (or a non-toggleable one) → bubble to submit.
      if (this.focusTarget.entry < 0) return "unhandled";
      if (!this.toggleFocused()) return "unhandled";
      this.commit(); // entries mutated in place — notify subscribers
      this.reveal();
      return "handled";
    }
    if (ch === "\x1b") {
      // Esc: leave entry focus mode. With the ring empty, return to the
      // input (the abort path lives on the input side of the ring).
      this.syncFromStore();
      if (this.focusTarget.entry >= 0) {
        this.clearFocus();
        return "handled";
      }
      setTopLevel("input");
      setState({}); // notify the scheduler so the input un-blurs
      return "handled";
    }
    return "unhandled";
  }

  /** Tab / Shift-Tab: move the focus ring and keep the target visible. */
  cycleFocus(dir: 1 | -1): void {
    this.syncFromStore();
    this.moveFocus(dir); // commits the new ring position
    this.reveal(); // commits only if the viewport had to scroll
  }
}
