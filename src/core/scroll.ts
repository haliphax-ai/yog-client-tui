/**
 * Scroll offset + follow-mode state — pure, terminal-free.
 *
 * The offset is always clamped into `[0, maxOffset]` on scroll. Follow
 * mode pins the viewport to the bottom; any scroll breaks it, and landing
 * back at the bottom (e.g. PageDown past the end) resumes it. Jumping to
 * the top stops follow; jumping to the bottom resumes it.
 */

/** Mutable scroll view state shared by the log viewport. */
export interface ScrollState {
  scrollOffset: number;
  follow: boolean;
}

/**
 * Clamp to the valid range for the current viewport; in follow mode the
 * offset is pinned to the bottom first.
 */
export function clampScroll(state: ScrollState, maxOffset: number): void {
  if (state.follow) state.scrollOffset = maxOffset;
  state.scrollOffset = Math.min(state.scrollOffset, maxOffset);
}

/** Scroll by `delta` rows (positive = toward the bottom). */
export function scrollBy(state: ScrollState, delta: number, maxOffset: number): void {
  state.follow = false;
  state.scrollOffset = Math.max(0, Math.min(maxOffset, state.scrollOffset + delta));
  if (state.scrollOffset >= maxOffset) state.follow = true;
}

/** Jump to the top of the log (stops follow) or the bottom (resumes it). */
export function jump(state: ScrollState, top: boolean): void {
  if (top) {
    state.follow = false;
    state.scrollOffset = 0;
  } else {
    state.follow = true;
    state.scrollOffset = Number.MAX_SAFE_INTEGER;
  }
}
