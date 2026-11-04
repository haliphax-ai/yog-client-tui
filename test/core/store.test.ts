import { beforeEach, describe, expect, it } from "vitest";
import { getState, resetForTests, setState, subscribe } from "../../src/core/store.ts";

describe("store", () => {
  beforeEach(() => {
    resetForTests();
  });

  it("merges partial patches and preserves other keys", () => {
    setState({ input: "hello", statusNote: "note" });
    setState({ input: "hi" });

    expect(getState().input).toBe("hi");
    expect(getState().statusNote).toBe("note");
    // untouched keys keep their defaults
    expect(getState().follow).toBe(true);
    expect(getState().entries).toEqual([]);
  });

  it("notifies on identical-value patches (in-place mutations rely on it)", () => {
    // Regression: toggles and table scroll mutate entries in place, then
    // commit a patch whose VALUES are reference-identical to current state.
    // The notification — not value comparison — is what makes them render.
    setState({ entries: [] });
    let calls = 0;
    subscribe(() => {
      calls += 1;
    });
    setState({ entries: getState().entries }); // same array ref, must flush
    expect(calls).toBe(1);
  });

  it("stops notifying after unsubscribe", () => {
    let calls = 0;
    const unsubscribe = subscribe(() => {
      calls += 1;
    });
    setState({ statusNote: "one" });
    unsubscribe();
    setState({ statusNote: "two" });
    expect(calls).toBe(1);
    expect(getState().statusNote).toBe("two");
  });

  it("clears state and listeners on resetForTests", () => {
    let calls = 0;
    subscribe(() => {
      calls += 1;
    });
    setState({ input: "dirty", statusNote: "note" });
    resetForTests();

    expect(getState().input).toBe("");
    expect(getState().statusNote).toBe("");
    expect(getState().follow).toBe(true);

    setState({ input: "after reset" });
    expect(calls).toBe(1); // listener was dropped by the reset
    expect(getState().input).toBe("after reset");
  });
});
