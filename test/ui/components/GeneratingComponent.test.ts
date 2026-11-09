import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GeneratingComponent } from "../../../src/ui/components/GeneratingComponent.ts";
import { resetForTests, setState, subscribe } from "../../../src/core/store.ts";
import { displayWidth, stripAnsi } from "../../../src/util/ansi.ts";

describe("GeneratingComponent", () => {
  beforeEach(() => {
    resetForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetForTests();
  });

  it("renders nothing while idle (fully collapsed)", () => {
    const gen = new GeneratingComponent();
    expect(gen.render({ cols: 80 })).toEqual([]);
    expect(gen.measure(80)).toBe(0);
  });

  it("renders one full-sized braille spinner row while busy", () => {
    const gen = new GeneratingComponent();
    setState({ busy: true });
    const rows = gen.render({ cols: 80 });
    expect(rows).toHaveLength(1);
    // Dot frame 0 is "⣾ " (braille + gap space) — the full-sized preset,
    // not the 1-cell MiniDot frame "⠋".
    expect(stripAnsi(rows[0] as string)).toBe("⣾ generating");
    expect(displayWidth(rows[0] as string)).toBe(12);
    expect(gen.measure(80)).toBe(1);
  });

  it("styles the spinner and label in bright purple", () => {
    const gen = new GeneratingComponent();
    setState({ busy: true });
    const row = gen.render({ cols: 80 })[0] as string;
    expect(row).toContain("38;2;192;132;252"); // #c084fc bright purple
    expect(row).not.toContain("48;2;63;63;70"); // no status-bar backing
  });

  it("advances through the Dot frames on the preset fps timer", () => {
    const gen = new GeneratingComponent();
    setState({ busy: true });
    gen.start();
    expect(stripAnsi(gen.render({ cols: 80 })[0] as string)).toBe("⣾ generating");
    vi.advanceTimersByTime(100);
    expect(stripAnsi(gen.render({ cols: 80 })[0] as string)).toBe("⣽ generating");
    vi.advanceTimersByTime(100);
    expect(stripAnsi(gen.render({ cols: 80 })[0] as string)).toBe("⣻ generating");
    // Wrap around the 8 Dot frames back to the start.
    vi.advanceTimersByTime(100 * 6);
    expect(stripAnsi(gen.render({ cols: 80 })[0] as string)).toBe("⣾ generating");
    gen.stop();
  });

  it("start is idempotent and stop halts advancement", () => {
    const gen = new GeneratingComponent();
    setState({ busy: true });
    gen.start();
    gen.start();
    vi.advanceTimersByTime(100);
    // A doubled timer would advance twice per tick.
    expect(stripAnsi(gen.render({ cols: 80 })[0] as string)).toBe("⣽ generating");
    gen.stop();
    gen.stop();
    vi.advanceTimersByTime(100 * 4);
    expect(stripAnsi(gen.render({ cols: 80 })[0] as string)).toBe("⣽ generating");
  });

  it("pokes the store on each tick so the scheduler redraws", () => {
    const gen = new GeneratingComponent();
    setState({ busy: true });
    let pokes = 0;
    const unsub = subscribe(() => {
      pokes += 1;
    });
    gen.start();
    vi.advanceTimersByTime(100);
    expect(pokes).toBeGreaterThan(0);
    gen.stop();
    unsub();
  });

  it("Dot braille frames are cell-accurate (braille is 1 cell, gap is 1 cell)", () => {
    // Regression guard for the AGENTS.md cell rule: the frame's trailing
    // space is a real cell the layout must count.
    expect(displayWidth("⣾ ")).toBe(2);
    expect(displayWidth("✅")).toBe(2);
  });
});
