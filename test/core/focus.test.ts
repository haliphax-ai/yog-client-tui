import { describe, expect, it } from "vitest";

import { FOCUS_NONE_TARGET, moveFocus, type FocusTarget } from "../../src/core/focus.ts";

/** A focus unit: an entry index + a table index within that entry. */
const U = (entry: number, table = -1): FocusTarget => ({ entry, table });

/**
 * The ring is computed by the UI layer (it knows which entries carry
 * tables); `core` only does the ring arithmetic. These tests exercise
 * that arithmetic over explicit unit lists.
 */
const RING: FocusTarget[] = [
  U(1), // chunk
  U(2), // tool
  U(4, 0), // table in prose entry 4
  U(5, 0), // table in prose entry 5
];

describe("moveFocus — flat ring over units", () => {
  it("enters at the first unit when starting from none (Tab)", () => {
    expect(moveFocus(RING, FOCUS_NONE_TARGET, 1)).toEqual(U(1));
  });

  it("enters at the last unit when starting from none (Shift-Tab)", () => {
    expect(moveFocus(RING, FOCUS_NONE_TARGET, -1)).toEqual(U(5, 0));
  });

  it("cycles forward through the ring", () => {
    expect(moveFocus(RING, U(1), 1)).toEqual(U(2));
    expect(moveFocus(RING, U(2), 1)).toEqual(U(4, 0));
    expect(moveFocus(RING, U(4, 0), 1)).toEqual(U(5, 0));
  });

  it("cycles backward through the ring", () => {
    expect(moveFocus(RING, U(5, 0), -1)).toEqual(U(4, 0));
    expect(moveFocus(RING, U(4, 0), -1)).toEqual(U(2));
    expect(moveFocus(RING, U(2), -1)).toEqual(U(1));
  });

  it("wraps through none at the end of the ring (Tab past last)", () => {
    expect(moveFocus(RING, U(5, 0), 1)).toEqual(FOCUS_NONE_TARGET);
    // …and the next press continues from that end.
    expect(moveFocus(RING, FOCUS_NONE_TARGET, 1)).toEqual(U(1));
  });

  it("wraps through none at the start of the ring (Shift-Tab past first)", () => {
    expect(moveFocus(RING, U(1), -1)).toEqual(FOCUS_NONE_TARGET);
    // …and the next press continues from that end.
    expect(moveFocus(RING, FOCUS_NONE_TARGET, -1)).toEqual(U(5, 0));
  });

  it("stays at none when there are no focusable units", () => {
    expect(moveFocus([], FOCUS_NONE_TARGET, 1)).toEqual(FOCUS_NONE_TARGET);
    expect(moveFocus([], U(0), -1)).toEqual(FOCUS_NONE_TARGET);
  });
});

describe("moveFocus — tables inside one entry are independent", () => {
  it("walks through both tables in a two-table entry before moving on", () => {
    const ring: FocusTarget[] = [U(0, 0), U(0, 1), U(1)];
    expect(moveFocus(ring, FOCUS_NONE_TARGET, 1)).toEqual(U(0, 0));
    expect(moveFocus(ring, U(0, 0), 1)).toEqual(U(0, 1));
    expect(moveFocus(ring, U(0, 1), 1)).toEqual(U(1));
  });
});

describe("moveFocus — a vanished target lands on the closest valid one", () => {
  it("steps forward from the nearest unit when the target is gone", () => {
    // The focused table disappeared (the entry's content changed).
    expect(moveFocus(RING, U(4, 3), 1)).toEqual(U(5, 0));
  });

  it("steps backward from the nearest unit when the target is gone", () => {
    expect(moveFocus(RING, U(4, 3), -1)).toEqual(U(2));
  });
});
