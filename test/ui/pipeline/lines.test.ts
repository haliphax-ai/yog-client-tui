import { describe, expect, it } from "vitest";

import { composeMainPane, padFrame, padLine } from "../../../src/ui/pipeline/lines.ts";

describe("composeMainPane — guaranteed single blank line between log and input", () => {
  it("reuses the viewport's trailing blank (separator/padding) as the gap", () => {
    expect(composeMainPane(["line1", ""], [], "▐ ", "status")).toEqual([
      "line1",
      "",
      "▐ ",
      "status",
    ]);
    expect(composeMainPane(["line1", "   "], [], "▐ ", "status")).toEqual([
      "line1",
      "   ",
      "▐ ",
      "status",
    ]);
  });

  it("consumes the bottom row as the gap when the viewport ends in content", () => {
    expect(composeMainPane(["line1", "line2"], [], "▐ ", "status")).toEqual([
      "line1",
      "",
      "▐ ",
      "status",
    ]);
    expect(composeMainPane(["\x1b[31mline1\x1b[m", "line2"], [], "▐ ", "status")).toEqual([
      "\x1b[31mline1\x1b[m",
      "",
      "▐ ",
      "status",
    ]);
  });

  it("tolerates an empty viewport (no content yet)", () => {
    expect(composeMainPane([], [], "▐ ", "status")).toEqual(["▐ ", "status"]);
  });

  it("places non-empty drawer rows directly after the log (drawer padding is the gap)", () => {
    expect(composeMainPane(["line1", ""], ["drawer-a", "drawer-b"], "▐ ", "status")).toEqual([
      "line1",
      "",
      "drawer-a",
      "drawer-b",
      "▐ ",
      "status",
    ]);
    expect(composeMainPane(["line1", "line2"], ["drawer"], "▐ ", "status")).toEqual([
      "line1",
      "line2",
      "drawer",
      "▐ ",
      "status",
    ]);
    expect(composeMainPane([], ["drawer"], "▐ ", "status")).toEqual(["drawer", "▐ ", "status"]);
  });
});

describe("padLine / padFrame", () => {
  it("pads a plain line to the width", () => {
    expect(padLine("ab", 4)).toBe("ab  ");
  });

  it("pads an ANSI-bearing line to the width", () => {
    const padded = padLine("\x1b[31mab\x1b[m", 4);
    expect(padded).toContain("\x1b[31mab\x1b[m");
    expect(padded).toHaveLength(4 + "\x1b[31m\x1b[m".length);
  });

  it("truncates an overlong line to the width", () => {
    expect(padLine("abcdef", 4)).toBe("abcd");
  });

  it("normalizes every frame line to the width", () => {
    expect(padFrame("ab\nc", 3)).toBe("ab \nc  ");
  });
});
