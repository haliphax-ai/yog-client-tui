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
    expect(s).toEqual({ scrollOffset: 40, follow: true });
  });

  it("clamps a stale offset down when content shrank", () => {
    const s = view(90, false);
    clampScroll(s, 12);
    expect(s).toEqual({ scrollOffset: 12, follow: false });
  });

  it("leaves an in-range offset alone when not following", () => {
    const s = view(7, false);
    clampScroll(s, 40);
    expect(s).toEqual({ scrollOffset: 7, follow: false });
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
    expect(s).toEqual({ scrollOffset: 25, follow: true });
  });
});
