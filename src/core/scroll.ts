/**
 * Scroll offset + follow-mode state — pure, terminal-free.
 *
 * The offset is always clamped into `[0, maxOffset]` on scroll. Follow
 * mode pins the viewport to the bottom; any scroll breaks it, and landing
 * back at the bottom (e.g. PageDown past the end) resumes it. Jumping to
 * the top stops follow; jumping to the bottom resumes it.
 *
 * Sticky bottom: while content streams in, the max offset grows BETWEEN
 * clamps. If follow was transiently lost (or a stale max was used to clamp),
 * the viewport ends up a few rows short of the bottom — "followed most of
 * the way, but not all the way". {@link clampScroll} re-engages follow when
 * the content grew since the previous clamp and the offset still sits at (or
 * past) that previous bottom. User scrolls upward never re-stick: they move
 * the offset BELOW the last-seen max without changing the max itself.
 */

/** Mutable scroll view state shared by the log viewport. */
export interface ScrollState {
  scrollOffset: number;
  follow: boolean;
  /** Max offset observed by the most recent clamp (growth discriminator). */
  lastMaxOffset?: number;
}

/**
 * Clamp to the valid range for the current viewport; in follow mode the
 * offset is pinned to the bottom first. When not following, an offset that
 * was the previous bottom while the content grew past it re-engages follow —
 * the signature of a lost follow during streaming, not of a user scroll.
 */
export function clampScroll(state: ScrollState, maxOffset: number): void {
  const lastMax = state.lastMaxOffset;
  if (state.follow) {
    state.scrollOffset = maxOffset;
  } else if (lastMax !== undefined && maxOffset > lastMax && state.scrollOffset >= lastMax) {
    // Content grew since the last clamp and the offset is still at that
    // previous bottom: the user never scrolled away — resume following.
    state.follow = true;
    state.scrollOffset = maxOffset;
  } else {
    state.scrollOffset = Math.min(state.scrollOffset, maxOffset);
  }
  state.lastMaxOffset = maxOffset;
}

/** Scroll by `delta` rows (positive = toward the bottom). A scroll that
 *  changes neither the offset nor follow (Down/Up already at that edge with
 *  follow already in the landing state) leaves the state untouched, so the
 *  caller can skip the flush. An upward scroll at the top still breaks
 *  follow: it cannot move, but it does detach from auto-follow. */
export function scrollBy(state: ScrollState, delta: number, maxOffset: number): void {
  const target = Math.max(0, Math.min(maxOffset, state.scrollOffset + delta));
  const following = target >= maxOffset;
  if (target === state.scrollOffset && following === state.follow) return;
  state.follow = following;
  state.scrollOffset = target;
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
