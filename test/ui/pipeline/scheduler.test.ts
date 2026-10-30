import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetForTests, setState } from "../../../src/core/store.ts";
import { createScheduler, FRAME_MS } from "../../../src/ui/pipeline/scheduler.ts";

beforeEach(() => {
  resetForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetForTests();
});

describe("frame coalescing", () => {
  it("exports the 16ms coalescing window", () => {
    expect(FRAME_MS).toBe(16);
  });

  it("runs the pipeline on flush, one frame later", () => {
    const run = vi.fn();
    createScheduler(run);
    expect(run).not.toHaveBeenCalled();
    setState({ statusNote: "go" }); // arms the coalescing timer
    vi.advanceTimersByTime(FRAME_MS);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("collapses a burst of rapid updates into a single flush", () => {
    const run = vi.fn();
    createScheduler(run);

    // A stream of store changes (e.g. SSE deltas) inside one window.
    setState({ statusNote: "a" });
    setState({ cursor: 1 });
    setState({ cursor: 2 });
    setState({ statusNote: "b" });
    setState({ busyFrame: 1 });
    expect(run).not.toHaveBeenCalled();

    vi.advanceTimersByTime(FRAME_MS);
    expect(run).toHaveBeenCalledTimes(1);

    // Nothing else fires after the flush — the window is spent.
    vi.advanceTimersByTime(FRAME_MS * 5);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("opens a fresh window after each flush", () => {
    const run = vi.fn();
    createScheduler(run);

    setState({ cursor: 1 });
    vi.advanceTimersByTime(FRAME_MS);
    expect(run).toHaveBeenCalledTimes(1);

    setState({ cursor: 2 });
    vi.advanceTimersByTime(FRAME_MS - 1);
    expect(run).toHaveBeenCalledTimes(1); // not yet — window still pending
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("arms the timer from the store subscription", () => {
    const run = vi.fn();
    createScheduler(run);
    setState({ statusNote: "changed" });
    vi.advanceTimersByTime(FRAME_MS);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("cancel() drops a pending flush without running it", () => {
    const run = vi.fn();
    const scheduler = createScheduler(run);
    setState({ cursor: 3 });
    scheduler.cancel();
    vi.advanceTimersByTime(FRAME_MS * 3);
    expect(run).not.toHaveBeenCalled();
  });

  it("dispose() cancels pending flushes and unsubscribes from the store", () => {
    const run = vi.fn();
    const scheduler = createScheduler(run);
    scheduler.dispose();

    setState({ cursor: 4 }); // no subscriber left — nothing armed
    vi.advanceTimersByTime(FRAME_MS * 3);
    expect(run).not.toHaveBeenCalled();
  });

  it("flush() runs immediately and clears the pending timer", () => {
    const run = vi.fn();
    const scheduler = createScheduler(run);
    setState({ cursor: 5 });
    scheduler.flush();
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(FRAME_MS * 3);
    expect(run).toHaveBeenCalledTimes(1); // the stale timer was cleared
  });

  it("honours a custom window for tests", () => {
    const run = vi.fn();
    createScheduler(run, 5);
    setState({ cursor: 6 });
    vi.advanceTimersByTime(5);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
