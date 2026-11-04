import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getState, resetForTests, setState } from "../../src/core/store.ts";
import { DEBUG_HEADER, emitDebug, isDebugEnabled } from "../../src/ui/debugLog.ts";

const OLD_ENV = process.env.YOG_DEBUG;

beforeEach(() => {
  resetForTests();
});

afterEach(() => {
  if (OLD_ENV === undefined) {
    delete process.env.YOG_DEBUG;
  } else {
    process.env.YOG_DEBUG = OLD_ENV;
  }
});

describe("client-side debug log", () => {
  it("is disabled unless YOG_DEBUG=1", () => {
    delete process.env.YOG_DEBUG;
    expect(isDebugEnabled()).toBe(false);
    emitDebug(["a"]);
    expect(getState().entries).toEqual([]);
  });

  it("creates a collapsed debug chunk with a header when enabled", () => {
    process.env.YOG_DEBUG = "1";
    emitDebug(["first"]);
    const entries = getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "debug", collapsed: true });
    expect(entries[0]?.lines[0]).toBe(DEBUG_HEADER);
    expect(entries[0]?.lines.slice(1)).toEqual(["first"]);
  });

  it("appends consecutive messages to the same chunk", () => {
    process.env.YOG_DEBUG = "1";
    emitDebug(["a", "b"]);
    emitDebug(["c"]);
    const entries = getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.lines.slice(1)).toEqual(["a", "b", "c"]);
  });

  it("starts a fresh chunk after a non-debug entry arrives", () => {
    process.env.YOG_DEBUG = "1";
    emitDebug(["one"]);
    // Simulate a non-debug push (as main.pushLines does).
    const state = getState();
    state.entries.push({ kind: "system", lines: ["hello"] });
    setState({ entries: state.entries });
    emitDebug(["two"]);
    const entries = getState().entries;
    expect(entries).toHaveLength(3);
    expect(entries[0]?.kind).toBe("debug");
    expect(entries[1]?.kind).toBe("system");
    expect(entries[2]?.kind).toBe("debug");
    expect(entries[2]?.lines.slice(1)).toEqual(["two"]);
  });

  it("ignores empty message batches", () => {
    process.env.YOG_DEBUG = "1";
    emitDebug([]);
    expect(getState().entries).toEqual([]);
  });
});
