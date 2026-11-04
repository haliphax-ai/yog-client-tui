import { beforeEach, describe, expect, it } from "vitest";

import { getState, resetForTests, setState } from "../../../src/core/store.ts";
import { InputComponent, MAX_LINES } from "../../../src/ui/components/InputComponent.ts";
import { getTopLevel, setTopLevel } from "../../../src/ui/components/keyRouter.ts";
import { stripAnsi } from "../../../src/util/ansi.ts";

/** Type a string into a component, one code point at a time. */
function typeText(component: InputComponent, text: string): void {
  for (const ch of text) {
    component.handleChar(ch);
  }
}

describe("InputComponent — bubbletea TextArea input bar", () => {
  beforeEach(() => resetForTests());

  it("renders a single row with the prompt when empty", () => {
    const out = new InputComponent().render({ cols: 80 }).split("\n");
    expect(out).toHaveLength(1);
    expect(stripAnsi(out[0] ?? "")).toContain("you ›");
  });

  it("typing inserts text and syncs the store (resetting completion)", () => {
    const component = new InputComponent();
    setState({ commandSel: 3 });
    typeText(component, "hi");
    expect(getState().input).toBe("hi");
    expect(getState().commandSel).toBe(0);
  });

  it("backspace removes the code point before the cursor", () => {
    const component = new InputComponent();
    typeText(component, "ab");
    expect(component.handleChar("\x7f")).toBe("handled");
    expect(getState().input).toBe("a");
  });

  it("delete removes the code point at the cursor", () => {
    const component = new InputComponent();
    typeText(component, "ab");
    component.handleKey("\x1b[D"); // left: between a|b
    expect(component.handleKey("\x1b[3~")).toBe("handled");
    expect(getState().input).toBe("a");
  });

  it("Enter is unhandled — submit bubbles to the globals", () => {
    const component = new InputComponent();
    typeText(component, "hi");
    expect(component.handleChar("\r")).toBe("unhandled");
    expect(component.handleChar("\n")).toBe("unhandled");
    expect(getState().input).toBe("hi"); // untouched — submission is global
  });

  it("Shift+Enter inserts a newline without submitting", () => {
    const component = new InputComponent();
    expect(component.handleKey("\x1b[13;2u")).toBe("handled");
    expect(getState().input).toBe("\n");
    const out = component.render({ cols: 80 }).split("\n");
    expect(out).toHaveLength(2);
  });

  it("pasted text with newlines is inserted literally and never submits", () => {
    const component = new InputComponent();
    component.paste("line1\nline2\nline3");
    expect(getState().input).toBe("line1\nline2\nline3");
    expect(component.handleChar("\r")).toBe("unhandled");
    expect(component.render({ cols: 80 }).split("\n")).toHaveLength(3);
  });

  it("paste normalizes CRLF to LF", () => {
    const component = new InputComponent();
    component.paste("a\r\nb");
    expect(getState().input).toBe("a\nb");
  });

  it("grows to fit content, up to MAX_LINES rows", () => {
    const component = new InputComponent();
    typeText(component, "x".repeat(80)); // soft-wraps to many visual rows
    const tall = component.render({ cols: 30 }).split("\n");
    expect(tall.length).toBeGreaterThan(1);
    expect(tall.length).toBeLessThanOrEqual(MAX_LINES);
  });

  it("caps height at MAX_LINES and scrolls vertically on overflow", () => {
    const component = new InputComponent();
    const lines = Array.from({ length: MAX_LINES + 2 }, (_, i) => `line${i}`);
    component.paste(lines.join("\n"));
    expect(component.measure(80)).toBe(MAX_LINES);
    const out = component.render({ cols: 80 }).split("\n");
    expect(out).toHaveLength(MAX_LINES);
    const text = out.map((line) => stripAnsi(line)).join("\n");
    // Cursor sits at the end, so the overflow scrolls the top lines out.
    expect(text).toContain(`line${MAX_LINES + 1}`);
    expect(text).not.toContain("line0");
  });

  it("Left/Right/Home/End are handled; Up/Down bubble on a single line", () => {
    const component = new InputComponent();
    typeText(component, "hi");
    expect(component.handleKey("\x1b[C")).toBe("handled");
    expect(component.handleKey("\x1b[D")).toBe("handled");
    expect(component.handleKey("\x1b[H")).toBe("handled");
    expect(component.handleKey("\x1b[F")).toBe("handled");
    expect(component.handleKey("\x1b[A")).toBe("unhandled"); // Up → log scroll
    expect(component.handleKey("\x1b[B")).toBe("unhandled"); // Down → log scroll
  });

  it("Up/Down move the caret when the input spans multiple lines", () => {
    const component = new InputComponent();
    component.paste("a\nb");
    expect(component.handleKey("\x1b[A")).toBe("handled");
    expect(component.handleKey("\x1b[B")).toBe("handled");
  });

  it("Ctrl+C is inert: not inserted, not handled", () => {
    const component = new InputComponent();
    typeText(component, "hi");
    expect(component.handleChar("\x03")).toBe("unhandled");
    expect(getState().input).toBe("hi");
  });
});

describe("InputComponent slash autocomplete", () => {
  beforeEach(() => resetForTests());

  it("shows a menu row with the matching command when input starts with '/'", () => {
    const component = new InputComponent();
    typeText(component, "/q");
    const out = component.render({ cols: 80 }).split("\n");
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(stripAnsi(out[1] ?? "")).toContain("/quit");
    expect(stripAnsi(out[1] ?? "")).toContain("exit");
  });

  it("hides the menu when the slash is not the first character", () => {
    const component = new InputComponent();
    typeText(component, "hi /q");
    expect(component.render({ cols: 80 }).split("\n")).toHaveLength(1);
  });

  it("Tab completes /q to /quit", () => {
    const component = new InputComponent();
    typeText(component, "/q");
    expect(component.handleChar("\t")).toBe("handled");
    expect(getState().input).toBe("/quit");
    expect(getState().commandSel).toBe(0); // single candidate — selection stays put
  });

  it("Tab on a bare slash completes to '/quit'", () => {
    const component = new InputComponent();
    component.handleChar("/");
    expect(component.handleChar("\t")).toBe("handled");
    expect(getState().input).toBe("/quit");
  });

  it("Tab preserves text after the token", () => {
    const component = new InputComponent();
    typeText(component, "/q args");
    expect(component.handleChar("\t")).toBe("handled");
    expect(getState().input).toBe("/quit args");
  });

  it("Tab falls through when autocomplete is inactive", () => {
    const component = new InputComponent();
    typeText(component, "hello");
    expect(component.handleChar("\t")).toBe("unhandled");
    expect(getState().input).toBe("hello");
  });
});

describe("InputComponent — textarea keybindings (full keymap reachable)", () => {
  beforeEach(() => {
    resetForTests();
    setTopLevel("input");
  });

  it("Ctrl+A / Ctrl+E jump to line start/end", () => {
    const component = new InputComponent();
    typeText(component, "hello");
    component.handleChar("\x01"); // ctrl+a → start
    component.handleChar("X");
    expect(getState().input).toBe("Xhello");
    component.handleChar("\x05"); // ctrl+e → end
    component.handleChar("Y");
    expect(getState().input).toBe("XhelloY");
  });

  it("Ctrl+W deletes the word before the cursor", () => {
    const component = new InputComponent();
    typeText(component, "hello world");
    component.handleChar("\x17"); // ctrl+w
    expect(getState().input).toBe("hello ");
  });

  it("Ctrl+K deletes from the cursor to the end of the line", () => {
    const component = new InputComponent();
    typeText(component, "hello world");
    component.handleChar("\x01"); // home
    component.handleChar("\x0b"); // ctrl+k
    expect(getState().input).toBe("");
  });

  it("Alt+Left moves one word backward (legacy ESC-b)", () => {
    const component = new InputComponent();
    typeText(component, "abc def");
    component.handleKey("\x1bb"); // alt+left
    component.handleChar("Z");
    expect(getState().input).toBe("abc Zdef");
  });

  it("modified arrow sequences reach the model (Ctrl+Left)", () => {
    const component = new InputComponent();
    typeText(component, "one two");
    expect(component.handleKey("\x1b[1;5D")).toBe("handled"); // ctrl+left
    component.handleChar("X");
    expect(getState().input).toBe("one Xtwo"); // start of the previous word
  });

  it("Shift+Up moves top-level focus to the log", () => {
    const component = new InputComponent();
    expect(component.handleKey("\x1b[1;2A")).toBe("handled");
    expect(getTopLevel()).toBe("log");
  });
});

describe("InputComponent — blurred input styling", () => {
  beforeEach(() => {
    resetForTests();
    setTopLevel("input");
  });

  it("renders dark grey text and a darker cursor when the log holds the ring", () => {
    const component = new InputComponent();
    typeText(component, "hi");
    setTopLevel("log");
    const out = component.render({ cols: 80 });
    expect(out).toContain("38;2;82;82;91"); // #52525b text
    expect(out).toContain("38;2;76;29;149"); // #4c1d95 cursor
  });

  it("renders the standard cursor color while the input holds the ring", () => {
    const component = new InputComponent();
    typeText(component, "hi");
    setTopLevel("input");
    const out = component.render({ cols: 80 });
    expect(out).toContain("38;2;124;58;237"); // #7c3aed cursor
  });
});
