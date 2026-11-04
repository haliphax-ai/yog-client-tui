import { beforeEach, describe, expect, it } from "vitest";

import { ChatViewport } from "../../../src/ui/components/ChatViewport.ts";
import { InputComponent } from "../../../src/ui/components/InputComponent.ts";
import { FOCUS_NONE_TARGET } from "../../../src/core/focus.ts";
import { getState, resetForTests, setState } from "../../../src/core/store.ts";
import {
  getTopLevel,
  routeChar,
  routeKey,
  setTopLevel,
  type Globals,
} from "../../../src/ui/components/keyRouter.ts";
import type { Component } from "../../../src/ui/components/Component.ts";
import type { LogEntry } from "../../../src/core/entries.ts";

/** Fixture: system(0), chunk(1), tool(2) — focusable: [1, 2]. */
function fixture(): LogEntry[] {
  const body: string[] = [];
  for (let i = 1; i <= 8; i++) body.push(`line ${i}`);
  return [
    { kind: "system", lines: ["connected"] },
    { kind: "chunk", lines: ["run exit 0", ...body] },
    { kind: "tool", lines: ["⚙️ run ✅"], label: "⚙️ run ✅", argsCompact: "", full: "" },
  ];
}

describe("top-level focus ring — integration with real components", () => {
  beforeEach(() => {
    resetForTests();
    setTopLevel("input");
    setState({ entries: fixture(), focusTarget: FOCUS_NONE_TARGET });
  });

  function wire() {
    const viewport = new ChatViewport();
    const input = new InputComponent();
    viewport.ring = "log";
    input.ring = "input";
    const chain: readonly Component[] = [viewport, input];
    const calls: string[] = [];
    const globals: Globals = {
      quit: () => calls.push("quit"),
      focusNext: () => viewport.cycleFocus(1),
      focusPrev: () => viewport.cycleFocus(-1),
      scrollBy: (delta) => calls.push(`scrollBy:${delta}`),
      jump: (top) => calls.push(`jump:${top}`),
      submit: () => calls.push("submit"),
      abortTurn: () => calls.push("abortTurn"),
      pageRows: () => 24,
    };
    return { viewport, input, chain, globals, calls };
  }

  it("typing reaches the input while it holds the ring", () => {
    const { chain, globals } = wire();
    expect(routeChar(chain, "h", globals)).toBe(true);
    expect(routeChar(chain, "i", globals)).toBe(true);
    expect(getState().input).toBe("hi");
  });

  it("Shift+Up moves to the log; log-side keys never reach the input", () => {
    const { chain, globals, input } = wire();
    routeChar(chain, "h", globals);
    expect(routeKey(chain, "\x1b[1;2A", globals)).toBe(true);
    expect(getTopLevel()).toBe("log");

    // A printable char while the log holds the ring is dropped.
    expect(routeChar(chain, "i", globals)).toBe(false);
    expect(getState().input).toBe("h");
    expect(input.measure(80)).toBe(1);
  });

  it("Tab cycles the log entry ring while the log holds the ring", () => {
    const { chain, globals } = wire();
    routeKey(chain, "\x1b[1;2A", globals);
    expect(getTopLevel()).toBe("log");
    expect(routeChar(chain, "\t", globals)).toBe(true);
    expect(getState().focusTarget).toEqual({ entry: 1, table: -1 });
  });

  it("Shift+Down returns to the input and typing resumes", () => {
    const { chain, globals } = wire();
    routeChar(chain, "h", globals);
    routeKey(chain, "\x1b[1;2A", globals);
    expect(routeKey(chain, "\x1b[1;2B", globals)).toBe(true);
    expect(getTopLevel()).toBe("input");
    expect(routeChar(chain, "i", globals)).toBe(true);
    expect(getState().input).toBe("hi");
  });

  it("Home/End operate the log viewport while it holds the ring", () => {
    const { chain, globals, calls } = wire();
    routeKey(chain, "\x1b[1;2A", globals);
    expect(routeKey(chain, "\x1b[H", globals)).toBe(true);
    expect(routeKey(chain, "\x1b[F", globals)).toBe(true);
    expect(calls).toEqual(["jump:true", "jump:false"]);
  });

  it("Enter submits only while the input holds the ring", () => {
    const { chain, globals, calls } = wire();
    routeChar(chain, "h", globals);
    expect(routeChar(chain, "\r", globals)).toBe(true);
    expect(calls).toEqual(["submit"]);

    routeKey(chain, "\x1b[1;2A", globals);
    expect(routeChar(chain, "\r", globals)).toBe(false); // dropped on the log
    expect(calls).toEqual(["submit"]);
  });
});

describe("top-level focus ring — input blur styling", () => {
  beforeEach(() => {
    resetForTests();
    setTopLevel("input");
    setState({ entries: [], focusTarget: FOCUS_NONE_TARGET });
  });

  function wire() {
    const viewport = new ChatViewport();
    const input = new InputComponent();
    viewport.ring = "log";
    input.ring = "input";
    const chain: readonly Component[] = [viewport, input];
    const globals: Globals = {
      quit: () => {},
      focusNext: () => viewport.cycleFocus(1),
      focusPrev: () => viewport.cycleFocus(-1),
      scrollBy: () => {},
      jump: () => {},
      submit: () => {},
      abortTurn: () => {},
      pageRows: () => 24,
    };
    return { chain, globals, input };
  }

  it("blurs the input visually while the log holds the ring, and restores it", () => {
    const { chain, globals, input } = wire();
    routeChar(chain, "h", globals);
    expect(input.render({ cols: 80 })).toContain("38;2;124;58;237"); // normal cursor

    expect(routeKey(chain, "\x1b[1;2A", globals)).toBe(true); // Shift+Up → log
    expect(getTopLevel()).toBe("log");
    const blurred = input.render({ cols: 80 });
    expect(blurred).toContain("38;2;82;82;91"); // dark grey text
    expect(blurred).toContain("38;2;76;29;149"); // darker cursor

    expect(routeKey(chain, "\x1b[1;2B", globals)).toBe(true); // Shift+Down → input
    expect(getTopLevel()).toBe("input");
    expect(input.render({ cols: 80 })).toContain("38;2;124;58;237");
  });
});
