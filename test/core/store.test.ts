import { beforeEach, describe, expect, it } from "vitest";
import { getState, resetForTests, setState, subscribe } from "../../src/core/store.ts";

describe("store", () => {
  beforeEach(() => {
    resetForTests();
  });

  it("merges partial patches and preserves other keys", () => {
    setState({ input: "hello", cursor: 5 });
    setState({ input: "hi" });

    expect(getState().input).toBe("hi");
    expect(getState().cursor).toBe(5);
    // untouched keys keep their defaults
    expect(getState().follow).toBe(true);
    expect(getState().entries).toEqual([]);
  });

  it("notifies subscribers on setState", () => {
    let calls = 0;
    subscribe(() => {
      calls += 1;
    });
    setState({ statusNote: "ok" });
    setState({ cursor: 1 });
    expect(calls).toBe(2);
    expect(getState().statusNote).toBe("ok");
  });

  it("does not notify when a patch changes nothing", () => {
    setState({ cursor: 3 });
    let calls = 0;
    subscribe(() => {
      calls += 1;
    });
    setState({ cursor: 3 }); // identical value — no-op
    setState({ statusNote: "" }); // equals the default — no-op
    setState({}); // empty patch — no-op
    expect(calls).toBe(0);
    expect(getState().cursor).toBe(3);
  });

  it("notifies once per patch and drops only identical keys", () => {
    let calls = 0;
    subscribe(() => {
      calls += 1;
    });
    setState({ cursor: 3, input: "x" });
    setState({ cursor: 3, input: "xy" }); // input changed → one flush
    expect(calls).toBe(2);
    expect(getState().input).toBe("xy");
  });

  it("stops notifying after unsubscribe", () => {
    let calls = 0;
    const unsubscribe = subscribe(() => {
      calls += 1;
    });
    setState({ cursor: 1 });
    unsubscribe();
    setState({ cursor: 2 });
    expect(calls).toBe(1);
    expect(getState().cursor).toBe(2);
  });

  it("clears state and listeners on resetForTests", () => {
    let calls = 0;
    subscribe(() => {
      calls += 1;
    });
    setState({ input: "dirty", cursor: 9 });
    resetForTests();

    expect(getState().input).toBe("");
    expect(getState().cursor).toBe(0);
    expect(getState().follow).toBe(true);

    setState({ input: "after reset" });
    expect(calls).toBe(1); // listener was dropped by the reset
    expect(getState().input).toBe("after reset");
  });
});
