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
import { FOCUS_NONE } from "../../core/focus.ts";
import { getState, setState } from "../../core/store.ts";

export class ChatViewport extends ChatLogComponent {
  /** Pull store state (entries, scroll, follow, focus ring) into the log. */
  private syncFromStore(): void {
    const state = getState();
    this.entries = state.entries;
    this.scrollOffset = state.scrollOffset;
    this.follow = state.follow;
    this.focusIndex = state.focusIndex;
  }

  /** Push mutations back to the store (notifies the render scheduler). */
  private commit(): void {
    setState({
      entries: this.entries,
      scrollOffset: this.scrollOffset,
      follow: this.follow,
      focusIndex: this.focusIndex,
    });
  }

  /** Rows available to this viewport in the current terminal layout. */
  private viewportHeight(): number {
    return this.viewportRows ?? Math.max(1, (process.stdout.rows ?? 24) - 2);
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

  override setFocus(index: number): void {
    super.setFocus(index);
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
    super.scrollBy(delta, viewportRows);
    this.commit();
  }

  override jump(top: boolean, viewportRows: number): void {
    this.syncFromStore();
    super.jump(top, viewportRows);
    this.commit();
  }

  override handleChar(ch: string): "handled" | "unhandled" {
    if (ch === "\r" || ch === "\n") {
      this.syncFromStore();
      // No focused entry (or a non-toggleable one) → bubble to submit.
      if (this.getFocusIndex() === FOCUS_NONE) return "unhandled";
      if (!this.toggleFocused()) return "unhandled";
      this.commit(); // entries mutated in place — notify subscribers
      this.reveal();
      return "handled";
    }
    if (ch === "\x1b") {
      // Esc: leave entry focus mode; nothing focused → bubble to the global
      // abort binding (the turn-abort Esc path).
      this.syncFromStore();
      if (this.getFocusIndex() !== FOCUS_NONE) {
        this.clearFocus();
        return "handled";
      }
      return "unhandled";
    }
    return "unhandled";
  }

  /** Tab / Shift-Tab: move the entry focus ring and keep the target visible. */
  cycleFocus(dir: 1 | -1): void {
    this.syncFromStore();
    this.moveFocus(dir); // commits the new ring position
    this.reveal(); // commits only if the viewport had to scroll
  }
}