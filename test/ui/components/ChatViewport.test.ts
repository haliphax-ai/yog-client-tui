import { beforeEach, describe, expect, it } from "vitest";

import { ChatViewport } from "../../../src/ui/components/ChatViewport.ts";
import { FOCUS_NONE } from "../../../src/core/focus.ts";
import { getState, resetForTests, setState, subscribe } from "../../../src/core/store.ts";
import { totalRows, type LogEntry } from "../../../src/ui/render/index.ts";

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

describe("ChatViewport — store-committed scrolling", () => {
  beforeEach(() => {
    resetForTests();
    setState({ entries: fixture() });
  });

  it("scrollBy notifies subscribers and updates the store offset", () => {
    let notifications = 0;
    subscribe(() => {
      notifications += 1;
    });
    setState({ follow: false, scrollOffset: 0 });
    notifications = 0;

    const viewport = new ChatViewport();
    viewport.setViewportRows(VIEWPORT);
    viewport.scrollBy(2, VIEWPORT); // toward the bottom: offset 0 → 2

    expect(notifications).toBeGreaterThan(0);
    expect(getState().scrollOffset).toBe(2);
    expect(getState().follow).toBe(false);
  });

  it("scrollBy breaking follow at the bottom resumes it in the store", () => {
    const viewport = new ChatViewport();
    viewport.setViewportRows(VIEWPORT);
    setState({ follow: false, scrollOffset: 0 });

    viewport.scrollBy(1_000, VIEWPORT); // past the end → clamp to bottom

    expect(getState().follow).toBe(true);
    expect(getState().scrollOffset).toBe(
      Math.max(0, totalRows(getState().entries, COLS) - VIEWPORT),
    );
  });

  it("jump(true) stops follow in the store; jump(false) resumes it", () => {
    const viewport = new ChatViewport();
    viewport.setViewportRows(VIEWPORT);

    viewport.jump(true, VIEWPORT);
    expect(getState().follow).toBe(false);
    expect(getState().scrollOffset).toBe(0);

    viewport.jump(false, VIEWPORT);
    expect(getState().follow).toBe(true);
    expect(getState().scrollOffset).toBe(
      Math.max(0, totalRows(getState().entries, COLS) - VIEWPORT),
    );
  });

  it("survives a subsequent render (no stale syncFromStore overwrite)", () => {
    const viewport = new ChatViewport();
    viewport.setViewportRows(VIEWPORT);
    setState({ follow: false, scrollOffset: 0 });

    viewport.scrollBy(2, VIEWPORT);
    viewport.render({ cols: COLS });

    expect(getState().scrollOffset).toBe(2);
  });
});

describe("ChatViewport — Tab / Shift-Tab entry focus ring", () => {
  beforeEach(() => {
    resetForTests();
    setState({ entries: fixture() });
  });

  it("cycleFocus(1) moves focusIndex through the store with wrap-through-none", () => {
    const viewport = new ChatViewport();
    expect(getState().focusIndex).toBe(FOCUS_NONE);

    viewport.cycleFocus(1);
    expect(getState().focusIndex).toBe(1); // chunk

    viewport.cycleFocus(1);
    expect(getState().focusIndex).toBe(2); // tool

    viewport.cycleFocus(1);
    expect(getState().focusIndex).toBe(FOCUS_NONE); // wrap through none

    viewport.cycleFocus(1);
    expect(getState().focusIndex).toBe(1); // re-enters from the start
  });

  it("cycleFocus(-1) wraps backward through none", () => {
    const viewport = new ChatViewport();

    viewport.cycleFocus(-1);
    expect(getState().focusIndex).toBe(2); // enters at the last focusable

    viewport.cycleFocus(-1);
    expect(getState().focusIndex).toBe(1);

    viewport.cycleFocus(-1);
    expect(getState().focusIndex).toBe(FOCUS_NONE);

    viewport.cycleFocus(-1);
    expect(getState().focusIndex).toBe(2); // re-enters from the end
  });

  it("keeps the store as the source of truth across cycles", () => {
    const viewport = new ChatViewport();
    let notifications = 0;
    subscribe(() => {
      notifications += 1;
    });

    viewport.cycleFocus(1);
    expect(notifications).toBeGreaterThan(0);
    expect(viewport.getFocusIndex()).toBe(getState().focusIndex);
  });
});

describe("ChatViewport — Esc routing", () => {
  beforeEach(() => {
    resetForTests();
    setState({ entries: fixture() });
  });

  it("claims Esc while an entry is focused: clears it and does not bubble", () => {
    const viewport = new ChatViewport();
    viewport.cycleFocus(1);
    expect(getState().focusIndex).toBe(1);

    expect(viewport.handleChar("\x1b")).toBe("handled");
    expect(getState().focusIndex).toBe(FOCUS_NONE);
  });

  it("bubbles Esc when nothing is focused (the turn-abort path)", () => {
    const viewport = new ChatViewport();
    expect(viewport.handleChar("\x1b")).toBe("unhandled");
  });
});
