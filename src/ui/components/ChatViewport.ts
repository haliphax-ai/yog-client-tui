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
import { type CopyActions } from "../../core/copyText.ts";

/** Shift+Down encodings — move top-level focus from the log to the input. */
const SHIFT_DOWN_SEQS: ReadonlySet<string> = new Set([
  "\x1b[1;2B", // xterm-style
  "\x1b[66;2u", // CSI-u / Kitty
]);

/** Shift+C encodings — copy the whole message / whole item (#109). */
const SHIFT_C_SEQS: ReadonlySet<string> = new Set([
  "\x1b[67;2u", // Kitty/CSI-u
  "\x1b[1;2C", // xterm modifyOtherKeys
  "\x1bC", // legacy
]);
/** Shift+T encodings — cycle backward through the focused entry's tables. */
const TABLE_CYCLE_SEQS: ReadonlySet<string> = new Set([
  "\x1b[84;2u", // Kitty/CSI-u
  "\x1b[1;2T", // xterm modifyOtherKeys
  "\x1bT", // legacy
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
  /**
   * Copy/output dispatch (#109): the composition root wires the clipboard
   * and `out/` writers; the viewport builds the request (per core/
   * copyText semantics) and hands it back. Undefined until wired — the
   * copy keys stay inert in tests that never wire a sink.
   */
  copyActions?: CopyActions;

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
    // Shift+C copies the whole message / whole item (#109).
    if (SHIFT_C_SEQS.has(seq)) return this.requestCopy(true, false);
    // Shift+T cycles backward through the focused entry's tables.
    if (TABLE_CYCLE_SEQS.has(seq)) return this.cycleTable(-1);
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
    // C / O copy or output the focused entry's raw Markdown (#109);
    // Shift+C copies the whole message / whole item.
    if (ch === "c") return this.requestCopy(false, false);
    if (ch === "C") return this.requestCopy(true, false);
    if (ch === "o") return this.requestCopy(false, true);
    if (ch === "O") return this.requestCopy(true, true);
    // T: cycle forward through the focused prose entry's tables.
    if (ch === "t") return this.cycleTable(1);
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

  /**
   * T / Shift+T: cycle through the tables of the focused prose entry.
   * Handled only while a prose entry is focused (`table >= 0` or the entry
   * itself with at least one table — the entry-level focus targets the
   * entry, so cycling moves into/out of its tables). Enter stays with the
   * table's expand/collapse; Esc unfocuses back to the log ring as usual.
   */
  private cycleTable(dir: 1 | -1): "handled" | "unhandled" {
    this.syncFromStore();
    const entry = this.entries[this.focusTarget.entry];
    if (entry === undefined) return "unhandled";
    if (entry.kind !== "user" && entry.kind !== "assistant") return "unhandled";
    const tableCount = splitTableSections(entry.lines.join("\n")).filter(
      (s) => s.kind === "table",
    ).length;
    if (tableCount === 0) return "unhandled";
    // Cycle at entry level: entry → table 0 → … → table N-1 → entry.
    const current = this.focusTarget.table;
    let next: number;
    if (current < 0) {
      next = dir === 1 ? 0 : tableCount - 1; // entering the tables
    } else {
      next = current + dir;
      if (next < 0) next = -1; // wrap back to the entry itself
      if (next >= tableCount) next = -1;
    }
    this.focusTarget = { entry: this.focusTarget.entry, table: next };
    this.commit();
    this.reveal();
    return "handled";
  }

  /**
   * C / Shift+C / O (#109): build the copy request for the focused entry
   * and run the wired sink. `upper` = Shift (whole message / whole item);
   * `output` = O (write out/<session id>_<item id>.md instead of the
   * clipboard). Unhandled when nothing is focused, the entry carries no
   * copy identity, or no sink is wired (tests).
   */
  private requestCopy(upper: boolean, output: boolean): "handled" | "unhandled" {
    const actions = this.copyActions;
    if (actions === undefined) return "unhandled";
    this.syncFromStore();
    if (this.focusTarget.entry < 0) return "unhandled";
    // A focused table copies the entry that contains it: the prose around
    // a table IS the raw Markdown the table belongs to.
    const entry = this.entries[this.focusTarget.entry];
    if (entry === undefined) return "unhandled";
    const request = actions.request(entry, upper);
    if (request === null) return "unhandled";
    if (output) actions.output(request);
    else actions.copy(request);
    return "handled";
  }

  /** Tab / Shift-Tab: move the focus ring and keep the target visible. */
  cycleFocus(dir: 1 | -1): void {
    this.syncFromStore();
    this.moveFocus(dir); // commits the new ring position
    this.reveal(); // commits only if the viewport had to scroll
  }
}
