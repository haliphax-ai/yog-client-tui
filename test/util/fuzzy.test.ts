import { describe, expect, it } from "vitest";

import { fuzzyFind, fuzzyMatches } from "../../src/util/fuzzy.ts";

describe("fuzzyMatches", () => {
  it("matches a contiguous prefix", () => {
    const m = fuzzyMatches("qu", "quit");
    expect(m).not.toBeNull();
    expect(m?.indices).toEqual([0, 1]);
  });

  it("matches a non-contiguous subsequence", () => {
    const m = fuzzyMatches("qt", "quit");
    expect(m).not.toBeNull();
    expect(m?.indices).toEqual([0, 3]);
  });

  it("returns null when the needle is not a subsequence", () => {
    expect(fuzzyMatches("qx", "quit")).toBeNull();
    expect(fuzzyMatches("uu", "quit")).toBeNull();
  });

  it("returns null when the needle is longer than the candidate", () => {
    expect(fuzzyMatches("quits", "quit")).toBeNull();
  });

  it("matches everything for an empty needle at score 0", () => {
    expect(fuzzyMatches("", "anything")).toEqual({
      item: "anything",
      score: 0,
      indices: [],
    });
  });

  it("matches case-insensitively by default", () => {
    expect(fuzzyMatches("QU", "quit")).not.toBeNull();
    expect(fuzzyMatches("q", "Quit")).not.toBeNull();
  });

  it("respects the caseSensitive option", () => {
    expect(fuzzyMatches("Q", "quit", { caseSensitive: true })).toBeNull();
    expect(fuzzyMatches("q", "quit", { caseSensitive: true })).not.toBeNull();
    expect(fuzzyMatches("Q", "Quit", { caseSensitive: true })).not.toBeNull();
  });
});

describe("fuzzyFind", () => {
  it("ranks consecutive runs above gappy matches", () => {
    const matches = fuzzyFind("ab", ["axb", "abc"]);
    expect(matches.map((m) => m.item)).toEqual(["abc", "axb"]);
  });

  it("ranks word/camel boundaries above mid-word matches", () => {
    expect(fuzzyFind("fb", ["foobar", "fooBar"]).map((m) => m.item)).toEqual(["fooBar", "foobar"]);
    expect(fuzzyFind("hw", ["helloworld", "hello world"]).map((m) => m.item)).toEqual([
      "hello world",
      "helloworld",
    ]);
  });

  it("ranks a candidate-start hit above a later hit", () => {
    expect(fuzzyFind("q", ["quit", "squint"]).map((m) => m.item)).toEqual(["quit", "squint"]);
  });

  it("keeps haystack order on tie scores (stable)", () => {
    expect(fuzzyFind("z", ["za", "zb"]).map((m) => m.item)).toEqual(["za", "zb"]);
  });

  it("returns all candidates for an empty needle, in haystack order", () => {
    const matches = fuzzyFind("", ["b", "a", "c"]);
    expect(matches.map((m) => m.item)).toEqual(["b", "a", "c"]);
    expect(matches.every((m) => m.score === 0)).toBe(true);
  });

  it("honors the limit option", () => {
    const matches = fuzzyFind("a", ["ax", "ay", "az"], { limit: 2 });
    expect(matches).toHaveLength(2);
  });

  it("exposes the matched indices per result", () => {
    const matches = fuzzyFind("qt", ["quit"]);
    expect(matches[0]?.indices).toEqual([0, 3]);
  });
});
