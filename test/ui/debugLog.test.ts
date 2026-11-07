import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getState, resetForTests, setState } from "../../src/core/store.ts";
import {
  DEBUG_HEADER,
  emitDebug,
  isDebugEnabled,
  isKeyLogEnabled,
  keyLogPath,
  setKeyDumpSink,
} from "../../src/ui/debugLog.ts";

const OLD_ENV = {
  YOG_DEBUG: process.env.YOG_DEBUG,
  YOG_DEBUG_KEYS: process.env.YOG_DEBUG_KEYS,
};

beforeEach(() => {
  resetForTests();
});

afterEach(() => {
  for (const key of ["YOG_DEBUG", "YOG_DEBUG_KEYS"] as const) {
    const old = OLD_ENV[key];
    if (old === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = old;
    }
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

  it("key logger is off unless YOG_DEBUG_KEYS is set", () => {
    delete process.env.YOG_DEBUG;
    delete process.env.YOG_DEBUG_KEYS;
    expect(isKeyLogEnabled()).toBe(false);
    expect(keyLogPath()).toBeUndefined();
  });

  it("YOG_DEBUG_KEYS=1 opts into chunk-only key logging (default path still reported)", () => {
    process.env.YOG_DEBUG = "1";
    process.env.YOG_DEBUG_KEYS = "1";
    expect(isKeyLogEnabled()).toBe(true);
    expect(keyLogPath()).toBe("/tmp/yog-client-keys.log");
  });

  it("YOG_DEBUG_KEYS alone is inert — no key diagnostics without YOG_DEBUG=1", () => {
    delete process.env.YOG_DEBUG;
    process.env.YOG_DEBUG_KEYS = "1";
    expect(isKeyLogEnabled()).toBe(false);
    emitDebug(["key 61"], "a");
    expect(getState().entries).toEqual([]);
  });

  it("YOG_DEBUG_KEYS=<path> routes raw chunks to the wired file sink", () => {
    process.env.YOG_DEBUG = "1";
    process.env.YOG_DEBUG_KEYS = "/tmp/yog-test-keys.log";
    expect(isKeyLogEnabled()).toBe(true);
    const dumps: string[] = [];
    setKeyDumpSink((raw) => dumps.push(raw));
    try {
      emitDebug(["key 61"], "a");
    } finally {
      setKeyDumpSink(undefined);
    }
    expect(dumps).toEqual(["a"]);
    expect(getState().entries[0]?.lines.slice(1)).toEqual(["key 61"]);
  });

  it("no file sink is consulted when the entry carries no raw chunk", () => {
    process.env.YOG_DEBUG = "1";
    process.env.YOG_DEBUG_KEYS = "/tmp/yog-test-keys.log";
    let called = 0;
    setKeyDumpSink(() => {
      called += 1;
    });
    try {
      emitDebug(["client-side debug log enabled"]);
    } finally {
      setKeyDumpSink(undefined);
    }
    expect(called).toBe(0);
    expect(getState().entries).toHaveLength(1);
  });
});
