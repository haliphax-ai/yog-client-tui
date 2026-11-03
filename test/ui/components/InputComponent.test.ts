import { beforeEach, describe, expect, it } from "vitest";

import { getState, resetForTests, setState } from "../../../src/core/store.ts";
import { InputComponent } from "../../../src/ui/components/InputComponent.ts";
import { stripAnsi } from "../../../src/util/ansi.ts";

function rows(patch: Parameters<typeof setState>[0]): string[] {
  setState(patch);
  return new InputComponent().render({ cols: 80 }).split("\n");
}

describe("InputComponent slash autocomplete", () => {
  beforeEach(() => resetForTests());

  it("shows a menu row with the matching command when input starts with '/'", () => {
    const out = rows({ input: "/q", cursor: 2 });
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(stripAnsi(out[1] ?? "")).toContain("/quit");
    expect(stripAnsi(out[1] ?? "")).toContain("exit");
  });

  it("renders a single row when input does not start with '/'", () => {
    expect(rows({ input: "hello world", cursor: 11 })).toHaveLength(1);
  });

  it("hides the menu when the slash is not the first character", () => {
    expect(rows({ input: "hi /q", cursor: 6 })).toHaveLength(1);
  });
});

describe("InputComponent slash key handling", () => {
  beforeEach(() => resetForTests());

  it("Tab completes '/q' to '/quit' and moves the cursor to its end", () => {
    setState({ input: "/q", cursor: 2 });
    const component = new InputComponent();
    expect(component.handleChar("\t")).toBe("handled");
    expect(getState().input).toBe("/quit");
    expect(getState().cursor).toBe(5);
  });

  it("Tab on a bare slash completes to '/quit'", () => {
    setState({ input: "/", cursor: 1 });
    const component = new InputComponent();
    expect(component.handleChar("\t")).toBe("handled");
    expect(getState().input).toBe("/quit");
  });

  it("Tab preserves text after the token", () => {
    setState({ input: "/q args", cursor: 3 });
    const component = new InputComponent();
    expect(component.handleChar("\t")).toBe("handled");
    expect(getState().input).toBe("/quit args");
    expect(getState().cursor).toBe(5);
  });

  it("Tab falls through when autocomplete is inactive", () => {
    setState({ input: "hello", cursor: 5 });
    const component = new InputComponent();
    expect(component.handleChar("\t")).toBe("unhandled");
    expect(getState().input).toBe("hello");
  });

  it("Ctrl+C is inert: not inserted, not handled", () => {
    setState({ input: "hi", cursor: 2 });
    const component = new InputComponent();
    expect(component.handleChar("\x03")).toBe("unhandled");
    expect(getState().input).toBe("hi");
  });

  it("typing resets the completion selection", () => {
    setState({ input: "/q", cursor: 2, commandSel: 3 });
    const component = new InputComponent();
    component.handleChar("x");
    expect(getState().commandSel).toBe(0);
  });

  it("backspace resets the completion selection", () => {
    setState({ input: "/quit", cursor: 5, commandSel: 2 });
    const component = new InputComponent();
    component.handleChar("\x7f");
    expect(getState().commandSel).toBe(0);
  });
});
