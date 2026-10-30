import { describe, expect, it } from "vitest";

import { ChatLogComponent } from "../../../src/ui/components/ChatLogComponent.ts";
import { FOCUS_NONE } from "../../../src/core/focus.ts";
import { totalRows, type LogEntry } from "../../../src/ui/render/index.ts";
import { stripAnsi } from "../../../src/util/ansi.ts";

/** Concrete log with test accessors for the scroll/follow state. */
class Log extends ChatLogComponent {
  setOffset(n: number): void {
    this.scrollOffset = n;
  }
  setFollow(v: boolean): void {
    this.follow = v;
  }
  offset(): number {
    return this.scrollOffset;
  }
}

/** Fresh chunk entry (8 body rows so it is collapsible). */
function chunkEntry(): LogEntry {
  const body: string[] = [];
  for (let i = 1; i <= 8; i++) body.push(`line ${i}`);
  return { kind: "chunk", lines: ["run exit 0", ...body] };
}

/** Fresh tool-call entry with label + compact + full args. */
function toolEntry(): LogEntry {
  return {
    kind: "tool",
    lines: ['⚙️ run ✅ {"a":1}'],
    label: "⚙️ run ✅",
    argsCompact: '{"a":1}',
    full: '{\n  "a": 1,\n  "b": 2\n}',
  };
}

/** Fixture: system(0), chunk(1), tool(2), assistant(3) — focusable: [1, 2]. */
function fixture(): LogEntry[] {
  return [
    { kind: "system", lines: ["connected"] },
    chunkEntry(),
    toolEntry(),
    { kind: "assistant", lines: ["hello **world**"] },
  ];
}

const COLS = 80;
const VIEWPORT = 3;

describe("ChatLogComponent — entries collection", () => {
  it("starts empty by default and accepts entries via constructor or setter", () => {
    expect(new Log().getEntries()).toEqual([]);
    const log = new Log(fixture());
    expect(log.getEntries()).toHaveLength(4);
    const replacement = [{ kind: "system" as const, lines: ["new"] }];
    log.setEntries(replacement);
    expect(log.getEntries()).toBe(replacement);
  });

  it("appends entries in place", () => {
    const log = new Log(fixture());
    log.appendEntry({ kind: "error", lines: ["boom"] });
    expect(log.getEntries()).toHaveLength(5);
    expect(log.getEntries()[4]?.kind).toBe("error");
  });
});

describe("ChatLogComponent — scroll clamp", () => {
  it("clamps a scroll past the end of the content", () => {
    const log = new Log(fixture());
    log.setViewportRows(VIEWPORT);
    log.scrollBy(1_000_000, VIEWPORT);
    expect(log.offset()).toBe(log.maxScrollOffset(VIEWPORT));
    expect(log.offset()).toBeGreaterThanOrEqual(0);
  });

  it("clamps a scroll above the top back to zero", () => {
    const log = new Log(fixture());
    log.setViewportRows(VIEWPORT);
    log.setFollow(false);
    log.scrollBy(-1_000_000, VIEWPORT);
    expect(log.offset()).toBe(0);
    expect(log.isFollowing()).toBe(false); // top jump never resumes follow
  });

  it("clamps a stale out-of-range offset at render time", () => {
    const log = new Log(fixture());
    log.setViewportRows(VIEWPORT);
    log.setFollow(false);
    log.setOffset(99_999);
    const rows = log.render({ cols: COLS });
    expect(log.offset()).toBe(log.maxScrollOffset(VIEWPORT));
    expect(rows).toHaveLength(VIEWPORT);
  });

  it("jumps resolve into the valid range", () => {
    const log = new Log(fixture());
    log.setViewportRows(VIEWPORT);
    log.jump(true, VIEWPORT);
    expect(log.offset()).toBe(0);
    log.jump(false, VIEWPORT);
    expect(log.offset()).toBe(log.maxScrollOffset(VIEWPORT));
  });
});

describe("ChatLogComponent — follow mode", () => {
  it("starts in follow mode", () => {
    expect(new Log(fixture()).isFollowing()).toBe(true);
  });

  it("breaks follow on any scroll away from the bottom", () => {
    const log = new Log(fixture());
    log.setViewportRows(VIEWPORT);
    log.scrollBy(-1, VIEWPORT);
    expect(log.isFollowing()).toBe(false);
  });

  it("resumes follow when scrolled back to the bottom", () => {
    const log = new Log(fixture());
    log.setViewportRows(VIEWPORT);
    log.scrollBy(-5, VIEWPORT);
    expect(log.isFollowing()).toBe(false);
    log.scrollBy(1_000, VIEWPORT);
    expect(log.isFollowing()).toBe(true);
    expect(log.offset()).toBe(log.maxScrollOffset(VIEWPORT));
  });

  it("jump to top stops follow; jump to bottom resumes it", () => {
    const log = new Log(fixture());
    log.setViewportRows(VIEWPORT);
    log.jump(true, VIEWPORT);
    expect(log.isFollowing()).toBe(false);
    expect(log.offset()).toBe(0);
    log.jump(false, VIEWPORT);
    expect(log.isFollowing()).toBe(true);
    expect(log.offset()).toBe(log.maxScrollOffset(VIEWPORT));
  });

  it("render pins follow mode to the bottom even from a stale offset", () => {
    const log = new Log(fixture());
    log.setViewportRows(VIEWPORT);
    log.setOffset(0);
    log.setFollow(true);
    log.render({ cols: COLS });
    expect(log.offset()).toBe(log.maxScrollOffset(VIEWPORT));
  });
});

describe("ChatLogComponent — focus ring (wrap through none)", () => {
  it("enters at the first focusable entry going forward", () => {
    const log = new Log(fixture());
    expect(log.getFocusIndex()).toBe(FOCUS_NONE);
    log.moveFocus(1);
    expect(log.getFocusIndex()).toBe(1); // chunk
    log.moveFocus(1);
    expect(log.getFocusIndex()).toBe(2); // tool
  });

  it("enters at the last focusable entry going backward", () => {
    const log = new Log(fixture());
    log.moveFocus(-1);
    expect(log.getFocusIndex()).toBe(2);
    log.moveFocus(-1);
    expect(log.getFocusIndex()).toBe(1);
  });

  it("wraps through none at the end of the ring", () => {
    const log = new Log(fixture());
    log.setFocus(2);
    log.moveFocus(1);
    expect(log.getFocusIndex()).toBe(FOCUS_NONE);
    log.moveFocus(1); // next press re-enters from the start
    expect(log.getFocusIndex()).toBe(1);
  });

  it("wraps through none at the start of the ring", () => {
    const log = new Log(fixture());
    log.setFocus(1);
    log.moveFocus(-1);
    expect(log.getFocusIndex()).toBe(FOCUS_NONE);
    log.moveFocus(-1); // next press re-enters from the end
    expect(log.getFocusIndex()).toBe(2);
  });

  it("stays at none when there is nothing focusable", () => {
    const log = new Log([{ kind: "system", lines: ["plain"] }]);
    log.moveFocus(1);
    expect(log.getFocusIndex()).toBe(FOCUS_NONE);
    log.moveFocus(-1);
    expect(log.getFocusIndex()).toBe(FOCUS_NONE);
  });

  it("setFocus/clearFocus manage focus directly", () => {
    const log = new Log(fixture());
    log.setFocus(3);
    expect(log.getFocusIndex()).toBe(3);
    log.clearFocus();
    expect(log.getFocusIndex()).toBe(FOCUS_NONE);
  });

  it("render colors only the focused entry", () => {
    const log = new Log(fixture());
    log.setViewportRows(VIEWPORT);
    // Park at the top so the chunk entry (index 1) is on screen.
    log.setFollow(false);
    log.setOffset(0);
    const unfocused = log.render({ cols: COLS }).join("\n");
    log.setFocus(1);
    const focused = log.render({ cols: COLS }).join("\n");
    expect(focused).toContain("\x1b[48"); // focus background present
    expect(focused).not.toBe(unfocused); // focus changes the rendered rows
  });
});

describe("ChatLogComponent — collapse/expand toggling", () => {
  it("toggles a focused chunk's collapsed flag", () => {
    const log = new Log(fixture());
    log.setFocus(1);
    expect(log.toggleFocused()).toBe(true);
    expect(log.getEntries()[1]?.collapsed).toBe(true);
    expect(log.toggleFocused()).toBe(true);
    expect(log.getEntries()[1]?.collapsed).toBe(false);
  });

  it("toggles a focused tool call's expanded flag", () => {
    const log = new Log(fixture());
    log.setFocus(2);
    expect(log.toggleFocused()).toBe(true);
    expect(log.getEntries()[2]?.expanded).toBe(true);
    expect(log.toggleFocused()).toBe(true);
    expect(log.getEntries()[2]?.expanded).toBe(false);
  });

  it("returns false for non-toggleable entries", () => {
    const log = new Log(fixture());
    log.setFocus(0); // system entry
    expect(log.toggleFocused()).toBe(false);
    expect(log.getEntries()[0]?.collapsed).toBeUndefined();
    expect(log.getEntries()[0]?.expanded).toBeUndefined();
  });

  it("returns false when nothing is focused", () => {
    const log = new Log(fixture());
    expect(log.getFocusIndex()).toBe(FOCUS_NONE);
    expect(log.toggleFocused()).toBe(false);
  });

  it("collapsing changes what render shows (fewer rows)", () => {
    const log = new Log(fixture());
    log.setViewportRows(12);
    log.setFocus(1);
    const open = log.render({ cols: COLS });
    log.toggleFocused();
    const closed = log.render({ cols: COLS });
    expect(open.some((r) => stripAnsi(r).includes("line 8"))).toBe(true);
    expect(closed.some((r) => stripAnsi(r).includes("… +3 lines"))).toBe(true);
    expect(closed.some((r) => stripAnsi(r).includes("line 8"))).toBe(false);
  });
});

describe("ChatLogComponent — memoized row cache", () => {
  it("reuses the cache across renders with identical inputs", () => {
    const log = new Log(fixture());
    log.setViewportRows(VIEWPORT);
    const entry = log.getEntries()[1] as LogEntry;
    const first = log.render({ cols: COLS });
    const cached = entry.cache;
    expect(cached).toBeDefined();

    const second = log.render({ cols: COLS });
    expect(entry.cache).toBe(cached); // same cache slot — no re-render
    expect(second.join("\n")).toBe(first.join("\n")); // byte-identical
  });

  it("invalidates on focus change", () => {
    const log = new Log(fixture());
    log.setViewportRows(VIEWPORT);
    const entry = log.getEntries()[1] as LogEntry;
    log.render({ cols: COLS });
    const before = entry.cache;
    log.setFocus(1);
    log.render({ cols: COLS });
    expect(entry.cache).not.toBe(before);
  });

  it("invalidates on width change", () => {
    const log = new Log(fixture());
    log.setViewportRows(VIEWPORT);
    const entry = log.getEntries()[3] as LogEntry;
    log.render({ cols: COLS });
    const before = entry.cache;
    log.render({ cols: 40 });
    expect(entry.cache).not.toBe(before);
    expect(entry.cache?.key).toContain("40|");
  });

  it("invalidates when entry content mutates", () => {
    const log = new Log(fixture());
    log.setViewportRows(VIEWPORT);
    const entry = log.getEntries()[3] as LogEntry;
    log.render({ cols: COLS });
    const before = entry.cache;
    entry.lines.push("more content");
    log.render({ cols: COLS });
    expect(entry.cache).not.toBe(before);
    const plain = stripAnsi(entry.cache?.rows.join("\n") ?? "");
    expect(plain).toContain("more content");
  });

  it("scrolling over a warm cache does not evict it", () => {
    const log = new Log(fixture());
    log.setViewportRows(VIEWPORT);
    const caches = (): (LogEntry["cache"] | undefined)[] => log.getEntries().map((e) => e.cache);
    log.render({ cols: COLS });
    const before = caches();
    log.scrollBy(-1, VIEWPORT);
    log.render({ cols: COLS });
    expect(caches()).toEqual(before);
  });
});

describe("ChatLogComponent — layout sizing", () => {
  it("renders exactly the assigned viewport rows, padded at the bottom", () => {
    const log = new Log(fixture());
    log.setViewportRows(6);
    const rows = log.render({ cols: COLS });
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.length >= 0)).toBe(true);
  });

  it("defaults to the full content height when no viewport is assigned", () => {
    const log = new Log(fixture());
    const rows = log.render({ cols: COLS });
    expect(rows).toHaveLength(totalRows(log.getEntries(), COLS));
  });

  it("measure reports the viewport height (or content when unassigned)", () => {
    const log = new Log(fixture());
    expect(log.measure(COLS)).toBe(totalRows(log.getEntries(), COLS));
    log.setViewportRows(4);
    expect(log.measure(COLS)).toBe(4);
  });
});
