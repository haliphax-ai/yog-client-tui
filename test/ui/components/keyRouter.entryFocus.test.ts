import { beforeEach, describe, expect, it } from "vitest";

import { ChatViewport } from "../../../src/ui/components/ChatViewport.ts";
import { FOCUS_NONE } from "../../../src/core/focus.ts";
import { getState, resetForTests, setState } from "../../../src/core/store.ts";
import {
  routeChar,
  routeKey,
  type Globals,
} from "../../../src/ui/components/keyRouter.ts";
import type { Component } from "../../../src/ui/components/Component.ts";
import type { LogEntry } from "../../../src/ui/render/index.ts";

/** Fixture: system(0), chunk(1), tool(2) — focusable: [1, 2]. */
function fixture(): LogEntry[] {
  const body: string[] = [];
  for (let i = 1; i <= 8; i++) body.push(`line ${i}`);
  return [
    { kind: "system", lines: ["connected"] },
    { kind: "chunk", lines: ["run exit 0", ...body] },
    {
      kind: "tool",
      lines: ['⚙️ run ✅ {"a":1}'],
      label: "⚙️ run ✅",
      argsCompact: '{"a":1}',
      full: '{\n  "a": 1,\n  "b": 2\n}',
    },
  ];
}

/**
 * The globals wiring used by `main.ts`: Tab / Shift-Tab drive the entry
 * focus ring on the store-backed viewport (not a component focus ring).
 */
function entryFocusGlobals(viewport: ChatViewport): Globals {
  return {
    quit: () => undefined,
    focusNext: () => viewport.cycleFocus(1),
    focusPrev: () => viewport.cycleFocus(-1),
    scrollBy: (delta) => viewport.scrollBy(delta, 24),
    jump: (top) => viewport.jump(top, 24),
    submit: () => undefined,
  };
}

describe("Tab / Shift-Tab → entry focus ring wiring", () => {
  beforeEach(() => {
    resetForTests();
    setState({ entries: fixture(), focusIndex: FOCUS_NONE });
  });

  it("Tab (routeChar) walks focusIndex forward through the store with wrap-through-none", () => {
    const viewport = new ChatViewport();
    const chain: readonly Component[] = [viewport];
    const globals = entryFocusGlobals(viewport);

    expect(routeChar(chain, "\t", globals)).toBe(true);
    expect(getState().focusIndex).toBe(1); // chunk

    expect(routeChar(chain, "\t", globals)).toBe(true);
    expect(getState().focusIndex).toBe(2); // tool

    expect(routeChar(chain, "\t", globals)).toBe(true);
    expect(getState().focusIndex).toBe(FOCUS_NONE); // wrap through none

    expect(routeChar(chain, "\t", globals)).toBe(true);
    expect(getState().focusIndex).toBe(1); // re-enters from the start
  });

  it("Shift-Tab (routeKey) walks focusIndex backward through the store", () => {
    const viewport = new ChatViewport();
    const chain: readonly Component[] = [viewport];
    const globals = entryFocusGlobals(viewport);

    expect(routeKey(chain, "\x1b[Z", globals)).toBe(true);
    expect(getState().focusIndex).toBe(2); // enters at the last focusable

    expect(routeKey(chain, "\x1b[Z", globals)).toBe(true);
    expect(getState().focusIndex).toBe(1);

    expect(routeKey(chain, "\x1b[Z", globals)).toBe(true);
    expect(getState().focusIndex).toBe(FOCUS_NONE);

    expect(routeKey(chain, "\x1b[Z", globals)).toBe(true);
    expect(getState().focusIndex).toBe(2); // re-enters from the end
  });
});