import { describe, expect, it } from "vitest";

import { ViewportComponent } from "../../../src/ui/components/ViewportComponent.ts";

/** Minimal concrete subclass with fixed content rows and exposed state. */
class TestViewport extends ViewportComponent {
  private content: string[];

  constructor(content: string[] = []) {
    super();
    this.content = content;
  }

  override produceRows(_cols: number): string[] {
    return [...this.content];
  }

  setOffset(n: number): void {
    this.scrollOffset = n;
  }
  setFollow(v: boolean): void {
    this.follow = v;
  }
  offset(): number {
    return this.scrollOffset;
  }
  following(): boolean {
    return this.follow;
  }
}

const CONTENT = ["line0", "line1", "line2", "line3", "line4"];
const COLS = 80;
const VIEWPORT = 3;

describe("ViewportComponent — clamping", () => {
  it("clamps scroll past the end to maxScrollOffset", () => {
    const vp = new TestViewport(CONTENT);
    vp.setViewportRows(VIEWPORT);
    vp.scrollBy(1_000_000, VIEWPORT);
    expect(vp.offset()).toBe(vp.maxScrollOffset(VIEWPORT));
    expect(vp.offset()).toBeGreaterThanOrEqual(0);
  });

  it("clamps scroll above the top back to zero", () => {
    const vp = new TestViewport(CONTENT);
    vp.setViewportRows(VIEWPORT);
    vp.setFollow(false);
    vp.scrollBy(-1_000_000, VIEWPORT);
    expect(vp.offset()).toBe(0);
  });

  it("clamps a stale out-of-range offset at render time", () => {
    const vp = new TestViewport(CONTENT);
    vp.setViewportRows(VIEWPORT);
    vp.setFollow(false);
    vp.setOffset(99_999);
    const rows = vp.render({ cols: COLS });
    expect(vp.offset()).toBe(vp.maxScrollOffset(VIEWPORT));
    expect(rows).toHaveLength(VIEWPORT);
  });
});

describe("ViewportComponent — follow mode", () => {
  it("starts in follow mode", () => {
    expect(new TestViewport(CONTENT).following()).toBe(true);
  });

  it("breaks follow on scroll away from bottom", () => {
    const vp = new TestViewport(CONTENT);
    vp.setViewportRows(VIEWPORT);
    vp.scrollBy(-1, VIEWPORT);
    expect(vp.following()).toBe(false);
  });

  it("resumes follow when scrolled back to bottom", () => {
    const vp = new TestViewport(CONTENT);
    vp.setViewportRows(VIEWPORT);
    vp.scrollBy(-5, VIEWPORT);
    expect(vp.following()).toBe(false);
    vp.scrollBy(1_000, VIEWPORT);
    expect(vp.following()).toBe(true);
    expect(vp.offset()).toBe(vp.maxScrollOffset(VIEWPORT));
  });

  it("jump to top stops follow; jump to bottom resumes it", () => {
    const vp = new TestViewport(CONTENT);
    vp.setViewportRows(VIEWPORT);
    vp.jump(true, VIEWPORT);
    expect(vp.following()).toBe(false);
    expect(vp.offset()).toBe(0);
    vp.jump(false, VIEWPORT);
    expect(vp.following()).toBe(true);
    expect(vp.offset()).toBe(vp.maxScrollOffset(VIEWPORT));
  });

  it("render pins follow to the bottom even from a stale offset", () => {
    const vp = new TestViewport(CONTENT);
    vp.setViewportRows(VIEWPORT);
    vp.setOffset(0);
    vp.setFollow(true);
    vp.render({ cols: COLS });
    expect(vp.offset()).toBe(vp.maxScrollOffset(VIEWPORT));
  });
});

describe("ViewportComponent — scrollBy", () => {
  it("scrolls forward by delta", () => {
    const vp = new TestViewport(CONTENT);
    vp.setViewportRows(VIEWPORT);
    vp.setFollow(false);
    vp.scrollBy(1, VIEWPORT);
    expect(vp.offset()).toBe(1);
  });

  it("scrolls backward by delta", () => {
    const vp = new TestViewport(CONTENT);
    vp.setViewportRows(VIEWPORT);
    vp.setFollow(false);
    vp.scrollBy(2, VIEWPORT);
    vp.scrollBy(-1, VIEWPORT);
    expect(vp.offset()).toBe(1);
  });
});

describe("ViewportComponent — jump", () => {
  it("jump(true) goes to top and stops follow", () => {
    const vp = new TestViewport(CONTENT);
    vp.setViewportRows(VIEWPORT);
    vp.jump(true, VIEWPORT);
    expect(vp.offset()).toBe(0);
    expect(vp.following()).toBe(false);
  });

  it("jump(false) goes to bottom and resumes follow", () => {
    const vp = new TestViewport(CONTENT);
    vp.setViewportRows(VIEWPORT);
    vp.jump(false, VIEWPORT);
    expect(vp.offset()).toBe(vp.maxScrollOffset(VIEWPORT));
    expect(vp.following()).toBe(true);
  });
});

describe("ViewportComponent — window slicing", () => {
  it("slices the correct visible window at an offset", () => {
    const vp = new TestViewport(CONTENT);
    vp.setViewportRows(VIEWPORT);
    vp.setFollow(false);
    vp.setOffset(1);
    const rows = vp.render({ cols: COLS });
    expect(rows).toHaveLength(VIEWPORT);
    expect(rows[0]).toBe("line1");
    expect(rows[1]).toBe("line2");
    expect(rows[2]).toBe("line3");
  });

  it("pads with blank rows when content is shorter than viewport", () => {
    const vp = new TestViewport(["a", "b"]);
    vp.setViewportRows(5);
    const rows = vp.render({ cols: COLS });
    expect(rows).toHaveLength(5);
    expect(rows[0]).toBe("a");
    expect(rows[1]).toBe("b");
    expect(rows[2]).toBe("");
    expect(rows[3]).toBe("");
    expect(rows[4]).toBe("");
  });

  it("returns full content when viewportRows is unset", () => {
    const vp = new TestViewport(CONTENT);
    const rows = vp.render({ cols: COLS });
    expect(rows).toHaveLength(CONTENT.length);
    expect(rows).toEqual(CONTENT);
  });

  it("handles empty content", () => {
    const vp = new TestViewport([]);
    vp.setViewportRows(3);
    const rows = vp.render({ cols: COLS });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r === "")).toBe(true);
  });
});

describe("ViewportComponent — measure", () => {
  it("reports full content height before setViewportRows", () => {
    const vp = new TestViewport(CONTENT);
    expect(vp.measure(COLS)).toBe(CONTENT.length);
  });

  it("reports the assigned viewport height after setViewportRows", () => {
    const vp = new TestViewport(CONTENT);
    vp.setViewportRows(4);
    expect(vp.measure(COLS)).toBe(4);
  });

  it("clamps setViewportRows to at least 1", () => {
    const vp = new TestViewport(CONTENT);
    vp.setViewportRows(0);
    expect(vp.measure(COLS)).toBe(1);
    vp.setViewportRows(-5);
    expect(vp.measure(COLS)).toBe(1);
  });
});

describe("ViewportComponent — totalWidth", () => {
  it("defaults to the initial cols (80)", () => {
    const vp = new TestViewport(CONTENT);
    expect(vp.totalWidth()).toBe(80);
  });

  it("updates after render", () => {
    const vp = new TestViewport(CONTENT);
    vp.render({ cols: 40 });
    expect(vp.totalWidth()).toBe(40);
  });
});
