import { describe, expect, it } from "vitest";

import { FOCUS_NONE, focusableChunks, moveFocus } from "../../src/core/focus.ts";

const k = (kind: string) => ({ kind });

describe("focusableChunks", () => {
  it("collects tool and chunk entry indices, skipping everything else", () => {
    const entries = [k("system"), k("tool"), k("user"), k("chunk"), k("assistant"), k("tool")];
    expect(focusableChunks(entries)).toEqual([1, 3, 5]);
  });

  it("is empty when there is nothing focusable", () => {
    expect(focusableChunks([k("system"), k("user")])).toEqual([]);
  });
});

describe("moveFocus ring", () => {
  const entries = [k("system"), k("tool"), k("user"), k("chunk"), k("tool")];
  // focusable: [1, 3, 4]

  it("enters at the first chunk when starting from none (Tab)", () => {
    expect(moveFocus(entries, FOCUS_NONE, 1)).toBe(1);
  });

  it("enters at the last chunk when starting from none (Shift-Tab)", () => {
    expect(moveFocus(entries, FOCUS_NONE, -1)).toBe(4);
  });

  it("cycles forward through the ring", () => {
    expect(moveFocus(entries, 1, 1)).toBe(3);
    expect(moveFocus(entries, 3, 1)).toBe(4);
  });

  it("cycles backward through the ring", () => {
    expect(moveFocus(entries, 4, -1)).toBe(3);
    expect(moveFocus(entries, 3, -1)).toBe(1);
  });

  it("wraps through none at the end of the ring (Tab past last)", () => {
    expect(moveFocus(entries, 4, 1)).toBe(FOCUS_NONE);
    // …and the next press continues from that end.
    expect(moveFocus(entries, FOCUS_NONE, 1)).toBe(1);
  });

  it("wraps through none at the start of the ring (Shift-Tab past first)", () => {
    expect(moveFocus(entries, 1, -1)).toBe(FOCUS_NONE);
    // …and the next press continues from that end.
    expect(moveFocus(entries, FOCUS_NONE, -1)).toBe(4);
  });

  it("stays at none when there are no focusable entries", () => {
    const plain = [k("system"), k("user")];
    expect(moveFocus(plain, FOCUS_NONE, 1)).toBe(FOCUS_NONE);
    expect(moveFocus(plain, 0, -1)).toBe(FOCUS_NONE);
  });
});
