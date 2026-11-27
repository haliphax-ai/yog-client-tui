import { describe, expect, it } from "vitest";

import { composeMainPane, padFrame, padLine } from "../../../src/ui/pipeline/index.ts";

describe("composeMainPane — exact row accounting (the drawer pad is the gap)", () => {
  it("concatenates viewport, drawer, input, status — nothing donated", () => {
    expect(composeMainPane(["line1", ""], [], "▐ ", "status")).toEqual([
      "line1",
      "",
      "▐ ",
      "status",
    ]);
    expect(composeMainPane(["line1", "line2"], [], "▐ ", "status")).toEqual([
      "line1",
      "line2",
      "▐ ",
      "status",
    ]);
    expect(composeMainPane(["line1"], ["drawer-a", "drawer-b"], "▐ ", "status")).toEqual([
      "line1",
      "drawer-a",
      "drawer-b",
      "▐ ",
      "status",
    ]);
    expect(composeMainPane([], [], "▐ ", "status")).toEqual(["▐ ", "status"]);
    expect(composeMainPane([], ["drawer"], "▐ ", "status")).toEqual(["drawer", "▐ ", "status"]);
    // ANSI-bearing rows pass through untouched.
    expect(composeMainPane(["\x1b[31mline1\x1b[m"], [], "▐ ", "status")).toEqual([
      "\x1b[31mline1\x1b[m",
      "▐ ",
      "status",
    ]);
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
