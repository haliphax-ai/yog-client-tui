import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastComponent } from "../../../src/ui/components/ToastComponent.ts";

/** The toast rows, ANSI-stripped, for plain-text assertions. */
function plain(component: ToastComponent, cols = 80): string[] {
  // eslint-disable-next-line no-control-regex
  return component.render({ cols }).map((row) => row.replace(/\x1b\[[0-9;]*m/g, ""));
}

describe("ToastComponent — stacked toasts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows one row per visible toast, oldest first", () => {
    const toast = new ToastComponent();
    toast.show("first");
    toast.show("second");
    expect(toast.render({ cols: 80 })).toMatchInlineSnapshot(`
      [
        "[38;2;148;163;184mfirst[m",
        "[38;2;148;163;184msecond[m",
      ]
    `);
  });

  it("each toast expires on its own timer", () => {
    const toast = new ToastComponent();
    toast.show("first");
    vi.advanceTimersByTime(1500);
    toast.show("second");
    expect(plain(toast)).toEqual(["first", "second"]);
    vi.advanceTimersByTime(1500); // first hits 3s
    expect(plain(toast)).toEqual(["second"]);
    vi.advanceTimersByTime(1500); // second hits 3s
    expect(plain(toast)).toEqual([]);
  });

  it("wraps a long message and keeps it as one toast", () => {
    const toast = new ToastComponent();
    toast.show("x".repeat(90));
    const rows = plain(toast, 40);
    expect(rows.length).toBeGreaterThan(1);
    expect(plain(toast, 40).length).toBe(rows.length); // stable
  });

  it("hide() clears every toast and its timers", () => {
    const toast = new ToastComponent();
    toast.show("a");
    toast.show("b");
    toast.hide();
    expect(plain(toast)).toEqual([]);
    vi.advanceTimersByTime(5000); // no stray timer throws
  });
});
