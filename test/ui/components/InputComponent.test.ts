import { beforeEach, describe, expect, it } from "vitest";

import { getState, resetForTests, setState } from "../../../src/core/store.ts";
import {
  InputComponent,
  MAX_INPUT_CHARS,
  MAX_LINES,
} from "../../../src/ui/components/InputComponent.ts";
import { getTopLevel, setTopLevel } from "../../../src/ui/components/keyRouter.ts";
import { displayWidth, stripAnsi } from "../../../src/util/ansi.ts";

/** Type a string into a component, one code point at a time. */
function typeText(component: InputComponent, text: string): void {
  for (const ch of text) {
    component.handleChar(ch);
  }
}

describe("InputComponent — bubbletea TextArea input bar", () => {
  beforeEach(() => resetForTests());

  it("renders a single row with the purple left border when empty", () => {
    const out = new InputComponent().render({ cols: 80 }).split("\n");
    expect(out).toHaveLength(1);
    const raw = out[0] ?? "";
    expect(stripAnsi(raw).startsWith("▐")).toBe(true);
    expect(stripAnsi(raw)).not.toContain("you ›");
    expect(raw).toContain("48;2;0;0;0"); // black backing
  });

  it("pads the text 1 cell inside the purple left border on black", () => {
    const component = new InputComponent();
    typeText(component, "hi");
    const raw = component.render({ cols: 80 }).split("\n")[0] ?? "";
    expect(stripAnsi(raw).startsWith("▐ hi")).toBe(true);
    expect(raw).toContain("48;2;0;0;0"); // black backing
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

  it("shows a menu row with the matching command when input starts with '/", () => {
    const component = new InputComponent();
    typeText(component, "/q");
    const out = component.render({ cols: 80 }).split("\n");
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(stripAnsi(out[1] ?? "")).toContain("quit");
    expect(stripAnsi(out[1] ?? "")).toContain("exit");
    expect(stripAnsi(out[1] ?? "")).not.toContain("/quit"); // slash implied
  });

  it("lists candidates across lines, ranked and without slashes", () => {
    const component = new InputComponent();
    typeText(component, "/");
    const out = component.render({ cols: 80 }).split("\n");
    const menu = out
      .slice(1)
      .map((line) => stripAnsi(line))
      .join("\n");
    expect(menu.split("\n").length).toBeGreaterThan(1); // multiline
    expect(menu).toContain("new");
    expect(menu).toContain("quit");
    expect(menu).toContain("start a fresh session");
    expect(menu).toContain("exit the client");
    expect(menu).not.toContain("/new");
    expect(menu).not.toContain("/quit");
  });

  it("truncates long summaries with an ellipsis, one row per candidate", () => {
    const component = new InputComponent();
    typeText(component, "/");
    const out = component.render({ cols: 24 }).split("\n");
    const menu = out.slice(1).map((line) => stripAnsi(line));
    expect(menu.length).toBeLessThanOrEqual(5);
    expect(menu.join("\n")).toContain("…");
    for (const line of menu) expect(displayWidth(line)).toBeLessThanOrEqual(24);
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

  it("Tab on a bare slash completes the first registry candidate", () => {
    const component = new InputComponent();
    component.handleChar("/");
    expect(component.handleChar("\t")).toBe("handled");
    expect(getState().input).toBe("/new");
  });

  it("extends the highlight to the viewport edge", () => {
    const component = new InputComponent();
    typeText(component, "/");
    const rows = component.render({ cols: 80 }).split("\n").slice(1);
    const selected = rows[0] ?? "";
    expect(selected).toContain("48;2;124;58;237"); // selection background
    expect(displayWidth(stripAnsi(selected))).toBe(80);
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

  it("shows the arg syntax and the full description on an exact match", () => {
    const component = new InputComponent();
    typeText(component, "/handoff");
    const rows = component.render({ cols: 80 }).split("\n").slice(1);
    const header = rows[0] ?? "";
    const descriptionRow = rows[1] ?? "";
    expect(stripAnsi(rows.join("\n"))).toContain("[guidance]");
    expect(stripAnsi(rows.join("\n"))).toContain("prepare a handoff document");
    const headerText = stripAnsi(header);
    expect(headerText).toContain("handoff [guidance]");
    expect(headerText).not.toContain("handoff  [guidance]");
    // Only the header row is highlighted; description lines stay dim with no
    // background, like unselected matches.
    expect(header).toContain("48;2;124;58;237"); // selected background
    expect(descriptionRow).toContain("38;2;148;163;184"); // dim foreground
    expect(descriptionRow).not.toContain("48;2"); // no background
  });

  it("keeps the summary while the token is only a prefix", () => {
    const component = new InputComponent();
    typeText(component, "/h");
    const menu = stripAnsi(component.render({ cols: 80 }).split("\n").slice(1).join("\n"));
    expect(menu).toContain("prepare a handoff document");
    expect(menu).not.toContain("[guidance]");
  });

  it("wraps an exact match description onto multiple lines when narrow", () => {
    const component = new InputComponent();
    typeText(component, "/handoff");
    const lines = component.render({ cols: 24 }).split("\n");
    expect(lines.length).toBeGreaterThan(2); // header + wrapped description rows
    const menu = lines.slice(1).map((row) => stripAnsi(row));
    const descriptionRows = menu.slice(1);
    expect(descriptionRows.length).toBeGreaterThan(1);
    for (const row of descriptionRows) expect(row.startsWith(" ")).toBe(false);
    for (const row of menu) expect(displayWidth(row)).toBeLessThanOrEqual(24);
  });

  it("Tab on a partial match completes the first ranked candidate", () => {
    const component = new InputComponent();
    typeText(component, "/h");
    expect(component.handleChar("\t")).toBe("handled");
    expect(getState().input).toBe("/handoff");
  });

  it("keeps the args view once a space has been typed", () => {
    const component = new InputComponent();
    typeText(component, "/handoff g");
    const text = stripAnsi(component.render({ cols: 80 }));
    expect(text).toContain("[guidance]");
    expect(text).toContain("prepare a handoff document");
  });

  it("returns to the fuzzy list when the token stops matching", () => {
    const component = new InputComponent();
    typeText(component, "/h g");
    const text = stripAnsi(component.render({ cols: 80 }));
    expect(text).not.toContain("[guidance]");
    expect(text).toContain("prepare a handoff document");
  });

  it("omits the tab marker and ignores Tab in the args view", () => {
    const component = new InputComponent();
    typeText(component, "/handoff g");
    const text = stripAnsi(component.render({ cols: 80 }));
    expect(text).not.toContain("↹");
    expect(component.handleChar("\t")).toBe("handled");
    expect(getState().input).toBe("/handoff g");
  });
});

describe("InputComponent — 5000-character cap", () => {
  beforeEach(() => resetForTests());

  it("accepts up to 5000 characters and truncates the rest", () => {
    const component = new InputComponent();
    component.paste("a".repeat(MAX_INPUT_CHARS));
    expect(component.textLength()).toBe(MAX_INPUT_CHARS);
    component.paste("b".repeat(50)); // beyond the cap — truncated
    expect(component.textLength()).toBe(MAX_INPUT_CHARS);
    expect(getState().input.length).toBe(MAX_INPUT_CHARS);
  });

  it("keeps the viewport capped at MAX_LINES rows regardless of length", () => {
    const component = new InputComponent();
    component.paste("x".repeat(MAX_INPUT_CHARS));
    expect(component.measure(80)).toBe(MAX_LINES);
    expect(component.render({ cols: 80 }).split("\n").length).toBe(MAX_LINES);
  });
});
