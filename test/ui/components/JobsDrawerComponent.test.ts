import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BACKGROUND_JOBS_FEATURE,
  JOBS_HEADERS,
  JOBS_POLL_MS,
  JobsDrawerComponent,
  jobColumnWidths,
  jobRowCells,
} from "../../../src/ui/components/index.ts";
import { getState, resetForTests, setState } from "../../../src/core/index.ts";
import { displayWidth, stripAnsi } from "../../../src/util/index.ts";

/** One detached-job row (shape mirrors the wire, fields pre-flattened). */
function job(over: Partial<Parameters<typeof jobRowCells>[0]> = {}): Parameters<typeof jobRowCells>[0] {
  return {
    id: "bg_1",
    tool: "bash",
    state: "running",
    startedAt: Date.now() - 5_000,
    ...over,
  };
}

describe("jobRowCells / jobColumnWidths", () => {
  it("shapes the five columns: id / tool / state / elapsed / exit", () => {
    const now = Date.now();
    const cells = jobRowCells(job({ startedAt: now - 65_000 }), now);
    expect(cells).toHaveLength(5);
    expect(cells[0]).toBe("bg_1");
    expect(cells[1]).toBe("bash");
    expect(cells[2]).toBe("running");
    expect(cells[3]).toMatch(/^1m/);
    expect(cells[4]).toBe("-");
  });

  it("stamps terminated rows with the reason", () => {
    const cells = jobRowCells(
      job({ state: "terminated", termReason: "max runtime", endedAt: Date.now() }),
      Date.now(),
    );
    expect(cells[2]).toBe("terminated(max runtime)");
  });

  it("carries the result's exit code when one settled in", () => {
    const cells = jobRowCells(job({ state: "finished", endedAt: Date.now(), result: { exitCode: 0 } }), Date.now());
    expect(cells[4]).toBe("exit 0");
  });

  it("measures widths in CELLS (emoji regression: ✅ is 2 cells)", () => {
    const cells = jobRowCells(
      job({ id: "✅", startedAt: Date.now() }),
      Date.now(),
    );
    const widths = jobColumnWidths([cells]);
    // "✅" is one character but two cells — the id column must fit it.
    expect(widths[0]).toBeGreaterThanOrEqual(2);
    expect(widths[0]).toBe(Math.max(2, displayWidth("id")));
  });
});

describe("JobsDrawerComponent", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing while closed — even when gated in", () => {
    const view = new JobsDrawerComponent();
    view.wire(async () => [job()], () => true);
    expect(view.render({ cols: 80 })).toEqual([]);
  });

  it("renders nothing when open but the server lacks the feature (capabilities gate)", () => {
    const view = new JobsDrawerComponent();
    view.wire(async () => [job()], () => false);
    setState({ jobsOpen: true });
    expect(view.render({ cols: 80 })).toEqual([]);
    expect(view.measure(80)).toBe(0);
  });

  it("renders the table while open and gated: header + one row per job", async () => {
    const view = new JobsDrawerComponent();
    view.wire(
      async () => [job({ id: "bg_1" }), job({ id: "bg_2", state: "finished" })],
      () => true,
    );
    view.toggle();
    await vi.waitFor(() => expect(getState().jobRows).toHaveLength(2));
    const rows = view.render({ cols: 80 });
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const plain = rows.map(stripAnsi);
    expect(plain.join("\n")).toContain("⏳ background jobs");
    for (const header of JOBS_HEADERS) expect(plain.join("\n")).toContain(header);
    expect(plain.join("\n")).toContain("bg_1");
    expect(plain.join("\n")).toContain("bg_2");
  });

  it("renders the empty note when the session has no jobs", async () => {
    const view = new JobsDrawerComponent();
    view.wire(async () => [], () => true);
    view.toggle();
    await vi.waitFor(() => expect(getState().jobRows).toEqual([]));
    const plain = view.render({ cols: 80 }).map(stripAnsi);
    expect(plain.join("\n")).toContain("(no background jobs)");
  });

  it("keeps the previous rows when a poll fails (best-effort)", async () => {
    const view = new JobsDrawerComponent();
    let fail = false;
    view.wire(
      async () => {
        if (fail) throw new Error("server unreachable");
        return [job({ id: "bg_1" })];
      },
      () => true,
    );
    view.toggle();
    await vi.waitFor(() => expect(getState().jobRows).toHaveLength(1));
    fail = true;
    await view.poll();
    expect(getState().jobRows).toHaveLength(1);
    const plain = view.render({ cols: 80 }).map(stripAnsi);
    expect(plain.join("\n")).toContain("bg_1");
  });

  it("toggling twice closes the view (and stops the poll)", async () => {
    const view = new JobsDrawerComponent();
    view.wire(async () => [job()], () => true);
    view.toggle();
    await vi.waitFor(() => expect(getState().jobsOpen).toBe(true));
    view.toggle();
    expect(getState().jobsOpen).toBe(false);
    expect(view.render({ cols: 80 })).toEqual([]);
  });

  it("exposes the constants the composition and docs reference", () => {
    expect(BACKGROUND_JOBS_FEATURE).toBe("background-jobs");
    expect(JOBS_POLL_MS).toBe(2000);
  });
});

describe("JobsDrawerComponent — /jobs + the Esc cascade", () => {
  beforeEach(() => {
    resetForTests();
  });

  it("toggle() reports availability: true when gated, false (and no flip) when not", () => {
    const gated = new JobsDrawerComponent();
    gated.wire(async () => [], () => true);
    expect(gated.toggle()).toBe(true);
    expect(getState().jobsOpen).toBe(true);

    resetForTests();
    const ungated = new JobsDrawerComponent();
    ungated.wire(async () => [], () => false);
    expect(ungated.toggle()).toBe(false);
    expect(getState().jobsOpen).toBe(false); // never flips ungated
  });

  it("toggle() closes an open view and reports true (the /jobs toggle-off path)", () => {
    const view = new JobsDrawerComponent();
    view.wire(async () => [], () => true);
    view.toggle();
    expect(view.toggle()).toBe(true);
    expect(getState().jobsOpen).toBe(false);
  });
});
