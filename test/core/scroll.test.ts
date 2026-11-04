import { describe, expect, it } from "vitest";

import { clampScroll, jump, scrollBy, type ScrollState } from "../../src/core/scroll.ts";

const view = (scrollOffset = 0, follow = false): ScrollState => ({ scrollOffset, follow });

describe("scrollBy", () => {
  it("moves within the valid range without touching follow mid-range", () => {
    const s = view(5, false);
    scrollBy(s, 3, 100);
    expect(s).toEqual({ scrollOffset: 8, follow: false });
    scrollBy(s, -10, 100);
    expect(s).toEqual({ scrollOffset: 0, follow: false });
  });

  it("clamps at the bottom and resumes follow there", () => {
    const s = view(95, false);
    scrollBy(s, 10, 100); // e.g. PageDown past the end
    expect(s).toEqual({ scrollOffset: 100, follow: true });
  });

  it("clamps at the top and does not resume follow", () => {
    const s = view(2, false);
    scrollBy(s, -50, 100);
    expect(s).toEqual({ scrollOffset: 0, follow: false });
  });

  it("breaks follow on any movement away from the bottom", () => {
    const s = view(100, true);
    scrollBy(s, -1, 100);
    expect(s).toEqual({ scrollOffset: 99, follow: false });
  });

  it("keeps follow when already at the bottom (maxOffset 0)", () => {
    const s = view(0, true);
    scrollBy(s, 5, 0);
    expect(s).toEqual({ scrollOffset: 0, follow: true });
  });
});

describe("clampScroll (draw-time clamp)", () => {
  it("pins follow mode to the bottom", () => {
    const s = view(3, true);
    clampScroll(s, 40);
    expect(s).toEqual({ scrollOffset: 40, follow: true, lastMaxOffset: 40 });
  });

  it("clamps a stale offset down when content shrank", () => {
    const s = view(90, false);
    clampScroll(s, 12);
    expect(s).toEqual({ scrollOffset: 12, follow: false, lastMaxOffset: 12 });
  });

  it("leaves an in-range offset alone when not following", () => {
    const s = view(7, false);
    clampScroll(s, 40);
    expect(s).toEqual({ scrollOffset: 7, follow: false, lastMaxOffset: 40 });
  });
});

describe("clampScroll — sticky bottom (streaming re-engage)", () => {
  it("re-engages follow when content grew past the previous bottom", () => {
    const s: ScrollState = { scrollOffset: 100, follow: false, lastMaxOffset: 100 };
    clampScroll(s, 140); // streamed in 40 rows since the last clamp
    expect(s.follow).toBe(true);
    expect(s.scrollOffset).toBe(140);
  });

  it("keeps re-pinning through consecutive growth clamps", () => {
    const s: ScrollState = { scrollOffset: 100, follow: false, lastMaxOffset: 100 };
    clampScroll(s, 120);
    clampScroll(s, 135);
    expect(s).toEqual({ scrollOffset: 135, follow: true, lastMaxOffset: 135 });
  });

  it("does not re-engage when the user scrolled up", () => {
    const s: ScrollState = { scrollOffset: 100, follow: false, lastMaxOffset: 100 };
    scrollBy(s, -30, 100); // user scroll: moves below the last-seen max
    clampScroll(s, 140); // content grows past the user's position
    expect(s.follow).toBe(false);
    expect(s.scrollOffset).toBe(70);
  });

  it("does not re-engage when content did not grow", () => {
    const s: ScrollState = { scrollOffset: 100, follow: false, lastMaxOffset: 100 };
    clampScroll(s, 100);
    expect(s.follow).toBe(false);
    expect(s.scrollOffset).toBe(100);
  });

  it("updates the growth baseline on every clamp", () => {
    const s: ScrollState = { scrollOffset: 100, follow: false, lastMaxOffset: 100 };
    clampScroll(s, 140); // resticks, baseline 140
    scrollBy(s, -5, 140); // user backs off to 135
    clampScroll(s, 141); // grew by 1 — user is below baseline, no yank
    expect(s.follow).toBe(false);
    expect(s.scrollOffset).toBe(135);
  });
});

describe("jump", () => {
  it("jump to top stops follow at offset 0", () => {
    const s = view(50, true);
    jump(s, true);
    expect(s).toEqual({ scrollOffset: 0, follow: false });
  });

  it("jump to bottom resumes follow (offset corrected at next clamp)", () => {
    const s = view(0, false);
    jump(s, false);
    expect(s.follow).toBe(true);
    expect(s.scrollOffset).toBe(Number.MAX_SAFE_INTEGER);
    clampScroll(s, 25);
    expect(s).toEqual({ scrollOffset: 25, follow: true, lastMaxOffset: 25 });
  });
});
