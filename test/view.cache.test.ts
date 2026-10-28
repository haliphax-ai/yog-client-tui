import { describe, expect, it } from "vitest";
import { cachedRows, type LogEntry } from "../src/ui/render/index.ts";
import { stripAnsi } from "../src/util/ansi.ts";

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

describe("cachedRows — signature hits", () => {
  it("reuses the same row array for an unchanged signature", () => {
    const entry: LogEntry = { kind: "system", lines: ["hello world"] };
    const first = cachedRows(entry, 40);
    const second = cachedRows(entry, 40);
    expect(second).toBe(first); // identical reference = no re-render
    expect(second).toEqual(first);
  });

  it("returns byte-identical rows across repeated calls", () => {
    const entry = chunkEntry();
    const first = cachedRows(entry, 40).join("\n");
    for (let i = 0; i < 3; i++) {
      expect(cachedRows(entry, 40).join("\n")).toBe(first);
    }
  });

  it("keys the cache on width and focus", () => {
    const entry: LogEntry = { kind: "system", lines: ["hello"] };
    const wide = cachedRows(entry, 40);
    expect(cachedRows(entry, 10)).not.toBe(wide); // width change = new render
    // back to the original signature: byte-identical, even if the slot moved
    expect(cachedRows(entry, 40).join("\n")).toBe(wide.join("\n"));
    // focus flip = new render (content only differs for styles that use focus;
    // see the chunk focus test below for the byte-level difference)
    const focused = cachedRows(entry, 40, true);
    const unfocused = cachedRows(entry, 40, false);
    expect(focused).not.toBe(unfocused);
  });
});

describe("cachedRows — mutation paths force a new render", () => {
  it("streaming append: adding a row re-renders", () => {
    const entry: LogEntry = { kind: "assistant", lines: ["chunk one"] };
    const before = cachedRows(entry, 40);
    entry.lines.push("chunk two");
    const after = cachedRows(entry, 40);
    expect(after).not.toBe(before);
    expect(after.join("\n")).not.toBe(before.join("\n"));
    expect(stripAnsi(after.join("\n"))).toContain("chunk two");
  });

  it("streaming append: growing the last row re-renders", () => {
    const entry: LogEntry = { kind: "assistant", lines: ["partial"] };
    const before = cachedRows(entry, 40);
    entry.lines[0] = "partial content";
    const after = cachedRows(entry, 40);
    expect(after).not.toBe(before);
    expect(stripAnsi(after.join("\n"))).toContain("partial content");
  });

  it("label amendment: re-appending args after the check re-renders", () => {
    const entry: LogEntry = {
      kind: "tool",
      lines: ["⚙️ run"],
      label: "⚙️ run",
      argsCompact: '{"a":1}',
    };
    const pending = cachedRows(entry, 40);
    // the result lands: label gains the check and the args re-attach
    entry.label = "⚙️ run ✅";
    entry.lines[0] = '⚙️ run ✅ {"a":1}';
    const done = cachedRows(entry, 40);
    expect(done).not.toBe(pending);
    expect(stripAnsi(done.join("\n"))).toContain("✅");
  });

  it("collapse: truncates the body and adds an ellipsis row", () => {
    const entry = chunkEntry();
    const open = cachedRows(entry, 40);
    const openLength = open.length;
    entry.collapsed = true;
    const closed = cachedRows(entry, 40);
    expect(closed).not.toBe(open);
    expect(closed.length).toBeLessThan(openLength);
    expect(closed.some((r) => stripAnsi(r).includes("… +3 lines"))).toBe(true);
    expect(closed.some((r) => stripAnsi(r).includes("line 8"))).toBe(false);
  });

  it("expand: restores the full body", () => {
    const entry = chunkEntry();
    entry.collapsed = true;
    const closed = cachedRows(entry, 40);
    entry.collapsed = false;
    const reopened = cachedRows(entry, 40);
    expect(reopened).not.toBe(closed);
    expect(reopened.length).toBeGreaterThan(closed.length);
    expect(reopened.some((r) => stripAnsi(r).includes("line 8"))).toBe(true);
    expect(reopened.some((r) => stripAnsi(r).includes("… +"))).toBe(false);
  });

  it("tool expand: switches from compact line to full args", () => {
    const entry = toolEntry();
    const collapsed = cachedRows(entry, 40);
    expect(collapsed.length).toBe(1);
    expect(stripAnsi(collapsed.join("\n"))).toContain('{"a":1}');
    entry.expanded = true;
    const expanded = cachedRows(entry, 40);
    expect(expanded).not.toBe(collapsed);
    expect(expanded.length).toBeGreaterThan(1);
    expect(stripAnsi(expanded.join("\n"))).toContain('"b"');
  });

  it("focus change: recolors chunk blocks", () => {
    const entry: LogEntry = { kind: "chunk", lines: ["run exit 0", "x"] };
    const unfocused = cachedRows(entry, 40, false);
    const focused = cachedRows(entry, 40, true);
    expect(focused).not.toBe(unfocused);
    expect(focused.join("\n")).not.toBe(unfocused.join("\n"));
    expect(focused.join("\n")).toContain("\x1b[48"); // focus background
  });

  it("width change: re-renders and changes wrapping", () => {
    const entry: LogEntry = {
      kind: "system",
      lines: ["hello world this is long"],
    };
    const wide = cachedRows(entry, 40);
    const narrow = cachedRows(entry, 10);
    expect(narrow).not.toBe(wide);
    expect(narrow.length).toBeGreaterThan(wide.length);
    expect(narrow.join("\n")).not.toBe(wide.join("\n"));
  });
});

describe("cachedRows — unchanged inputs stay cached", () => {
  it("flags that do not affect rendering do not invalidate", () => {
    const entry: LogEntry = {
      kind: "assistant",
      lines: ["hello"],
      streaming: true,
    };
    const before = cachedRows(entry, 40);
    entry.streaming = false;
    expect(cachedRows(entry, 40)).toBe(before);
  });

  it("an entry evicted to another object does not reuse the stale rows", () => {
    const a: LogEntry = { kind: "system", lines: ["same"] };
    const b: LogEntry = { kind: "system", lines: ["same"] };
    const rowsA = cachedRows(a, 40);
    const rowsB = cachedRows(b, 40);
    expect(rowsB).not.toBe(rowsA); // identity check on cache.entry
    expect(rowsB).toEqual(rowsA); // but byte-identical content
  });
});