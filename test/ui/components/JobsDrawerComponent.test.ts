import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BACKGROUND_JOBS_FEATURE,
  JOBS_HEADERS,
  JOBS_POLL_MS,
  JobsDrawerComponent,
  JOBS_MAX_ROWS,
  jobsTable,
  jobRowCells,
  visibleJobs,
} from "../../../src/ui/components/index.ts";
import {
  dismissDrawerChildren,
  drawerCommands,
  drawerSlashCommands,
  registerDrawerChild,
  resetDrawerRegistryForTests,
  runDrawerCommand,
} from "../../../src/ui/components/index.ts";
import { getState, resetForTests, setState } from "../../../src/core/index.ts";
import { BaseComponent, type RenderResult } from "../../../src/ui/components/index.ts";
import { displayWidth, stripAnsi } from "../../../src/util/index.ts";

/** One detached-job row (shape mirrors the wire, fields pre-flattened). */
function job(
  over: Partial<Parameters<typeof jobRowCells>[0]> = {},
): Parameters<typeof jobRowCells>[0] {
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
    const cells = jobRowCells(
      job({ state: "finished", endedAt: Date.now(), result: { exitCode: 0 } }),
      Date.now(),
    );
    expect(cells[4]).toBe("exit 0");
  });
});

describe("jobsTable (engine-built)", () => {
  it("parses through the shared table engine: columns match the headers", () => {
    const table = jobsTable([...JOBS_HEADERS], [["bg_1", "bash", "running", "1m", "-"]]);
    expect(table.columns.map((c) => c.title)).toEqual([...JOBS_HEADERS]);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toEqual(["bg_1", "bash", "running", "1m", "-"]);
  });

  it("rectifies ragged rows (engine GFM normalization)", () => {
    const table = jobsTable([...JOBS_HEADERS], [["bg_1", "bash"]]);
    expect(table.rows[0]).toHaveLength(JOBS_HEADERS.length);
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
    view.wire(
      async () => [job()],
      () => true,
    );
    expect(view.render({ cols: 80 })).toEqual([]);
  });

  it("renders nothing when open but the server lacks the feature (capabilities gate)", () => {
    const view = new JobsDrawerComponent();
    view.wire(
      async () => [job()],
      () => false,
    );
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
    view.wire(
      async () => [],
      () => true,
    );
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
    view.wire(
      async () => [job()],
      () => true,
    );
    view.toggle();
    await vi.waitFor(() => expect(getState().jobsOpen).toBe(true));
    view.toggle();
    expect(getState().jobsOpen).toBe(false);
    expect(view.render({ cols: 80 })).toEqual([]);
  });

  it("exposes the feature constant the composition references", () => {
    expect(BACKGROUND_JOBS_FEATURE).toBe("background-jobs");
  });

  it("onJobEvent: job.started adds a running row; job.settled stamps the result", () => {
    resetForTests();
    const view = new JobsDrawerComponent();
    const announced: Array<{ state: string; detail: string }> = [];
    view.wire(
      async () => [],
      () => true,
      (state, detail) => announced.push({ state, detail }),
    );
    view.toggle();
    setState({ jobsOpen: true });
    expect(view.onJobEvent("job.started", { id: "bg_1", tool: "bash", startedAt: 1000 })).toBe(
      true,
    );
    expect(
      view.onJobEvent("job.settled", {
        id: "bg_1",
        state: "finished",
        startedAt: 1000,
        endedAt: 4000,
        durationMs: 3000,
        result: { exitCode: 0 },
      }),
    ).toBe(true);
    const rows = getState().jobRows ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.join(" ")).toContain("bg_1");
    expect(rows[0]!.join(" ")).toContain("finished");
    expect(rows[0]!.join(" ")).toContain("exit 0");
    expect(announced).toHaveLength(1);
    expect(announced[0]!.state).toBe("finished");
    // Unknown event types are ignored (old servers never send these).
    expect(view.onJobEvent("job.poked", { id: "bg_1" })).toBe(false);
  });
});

describe("JobsDrawerComponent — poll transition notices", () => {
  beforeEach(() => {
    resetForTests();
  });

  /** Wire an open view against a mutable rows cell + a spy announcer;
   *  the first (toggle) poll establishes the baseline snapshot. */
  function openWith(rows: Parameters<typeof jobRowCells>[0][]): {
    view: JobsDrawerComponent;
    announced: Array<{ state: string; detail: string }>;
    setRows(rows: Parameters<typeof jobRowCells>[0][]): void;
  } {
    const announced: Array<{ state: string; detail: string }> = [];
    const view = new JobsDrawerComponent();
    let current = rows;
    view.wire(
      async () => current,
      () => true,
      (state, detail) => announced.push({ state, detail }),
    );
    view.toggle();
    return {
      view,
      announced,
      setRows(next: Parameters<typeof jobRowCells>[0][]) {
        current = next;
      },
    };
  }

  it("announces running → terminated with the reason once the poll sees it", async () => {
    const { view, announced, setRows } = openWith([job({ id: "bg_1", state: "running" })]);
    await vi.waitFor(() => expect(getState().jobRows).toHaveLength(1));
    expect(announced).toEqual([]); // the baseline poll announces nothing
    setRows([job({ id: "bg_1", state: "terminated", termReason: "operator abort" })]);
    await view.poll();
    expect(announced).toEqual([{ state: "terminated", detail: "bg_1 (operator abort)" }]);
  });

  it("announces running → finished with the tool name as the detail head", async () => {
    const { view, announced, setRows } = openWith([job({ id: "bg_2", state: "running" })]);
    await vi.waitFor(() => expect(getState().jobRows).toHaveLength(1));
    setRows([job({ id: "bg_2", state: "finished", endedAt: Date.now() })]);
    await view.poll();
    expect(announced).toEqual([{ state: "finished", detail: "bg_2" }]);
  });

  it("stays silent when nothing settled between polls", async () => {
    const { view, announced } = openWith([job({ id: "bg_1" })]);
    await vi.waitFor(() => expect(getState().jobRows).toHaveLength(1));
    await view.poll();
    await view.poll();
    expect(announced).toEqual([]);
  });

  it("announces nothing for settled jobs the view never watched run (no baseline)", async () => {
    // A FRESH view whose first snapshot already holds the settled job:
    // there is no rendered baseline, so no transition is announced.
    const { announced } = openWith([job({ id: "bg_1", state: "running" })]);
    await vi.waitFor(() => expect(getState().jobRows).toHaveLength(1));
    expect(announced).toEqual([]);
    const fresh = new JobsDrawerComponent();
    fresh.wire(
      async () => [job({ id: "bg_9", state: "terminated", termReason: "max runtime" })],
      () => true,
      (state, detail) => announced.push({ state, detail }),
    );
    fresh.toggle();
    await fresh.poll();
    expect(announced).toEqual([]);
  });
});

describe("JobsDrawerComponent — /jobs + the Esc cascade", () => {
  beforeEach(() => {
    resetForTests();
  });

  it("toggle() reports availability: true when gated, false (and no flip) when not", () => {
    const gated = new JobsDrawerComponent();
    gated.wire(
      async () => [],
      () => true,
    );
    expect(gated.toggle()).toBe(true);
    expect(getState().jobsOpen).toBe(true);

    resetForTests();
    const ungated = new JobsDrawerComponent();
    ungated.wire(
      async () => [],
      () => false,
    );
    expect(ungated.toggle()).toBe(false);
    expect(getState().jobsOpen).toBe(false); // never flips ungated
  });

  it("toggle() closes an open view and reports true (the /jobs toggle-off path)", () => {
    const view = new JobsDrawerComponent();
    view.wire(
      async () => [],
      () => true,
    );
    view.toggle();
    expect(view.toggle()).toBe(true);
    expect(getState().jobsOpen).toBe(false);
  });
});

describe("the drawer registry hook (dismiss + commands)", () => {
  beforeEach(() => {
    resetDrawerRegistryForTests();
    resetForTests();
  });
  afterEach(() => {
    resetDrawerRegistryForTests();
  });

  it("dismiss() joins the Esc cascade: claims Esc while open, passes when shut", () => {
    const view = new JobsDrawerComponent();
    view.wire(
      async () => [],
      () => true,
    );
    registerDrawerChild(view);

    expect(dismissDrawerChildren()).toBe(false); // shut — the cascade falls through
    view.toggle();
    expect(dismissDrawerChildren()).toBe(true); // claimed
    expect(getState().jobsOpen).toBe(false); // and closed
  });

  it("the newest registered child wins the Esc cascade (registration order)", () => {
    let newerDismissed = false;
    const view = new JobsDrawerComponent();
    view.wire(
      async () => [],
      () => true,
    );
    const newer: BaseComponent = new (class extends BaseComponent {
      dismiss(): boolean {
        newerDismissed = true;
        return true;
      }
      override render(): RenderResult {
        return [];
      }
    })(false);
    registerDrawerChild(view);
    registerDrawerChild(newer);
    view.toggle();
    expect(getState().jobsOpen).toBe(true);
    expect(dismissDrawerChildren()).toBe(true);
    expect(newerDismissed).toBe(true); // newest-first: the newer child claims Esc
    expect(getState().jobsOpen).toBe(true); // the cascade STOPPED there — the view never saw it
  });

  it("drawerCommands() declares /jobs and runDrawerCommand dispatches it", () => {
    const view = new JobsDrawerComponent();
    view.wire(
      async () => [],
      () => true,
    );
    registerDrawerChild(view);
    const commands = drawerCommands();
    expect(commands.map((c) => c.command.name)).toEqual(["jobs"]);
    const runner = runDrawerCommand("jobs");
    expect(runner).toBeDefined();
    runner!();
    expect(getState().jobsOpen).toBe(true);
  });

  it("a drawer command from an ungated child refuses (run returns false)", () => {
    const view = new JobsDrawerComponent();
    view.wire(
      async () => [],
      () => false,
    ); // server lacks the feature
    registerDrawerChild(view);
    const runner = runDrawerCommand("jobs");
    expect(runner).toBeDefined();
    // run() returns false — the dispatcher shows the unavailable note.
    expect(view.toggle()).toBe(false);
  });

  it("drawerSlashCommands() strips any message (client-local by construction)", () => {
    const view = new JobsDrawerComponent();
    view.wire(
      async () => [],
      () => true,
    );
    registerDrawerChild(view);
    const slash = drawerSlashCommands();
    expect(slash.map((c) => c.name)).toEqual(["jobs"]);
    expect(slash[0]!.message).toBeUndefined();
  });

  it("unregistering a child removes its commands from the registry hook", () => {
    const view = new JobsDrawerComponent();
    view.wire(
      async () => [],
      () => true,
    );
    const remove = registerDrawerChild(view);
    expect(drawerCommands()).toHaveLength(1);
    remove();
    expect(drawerCommands()).toHaveLength(0);
    expect(runDrawerCommand("jobs")).toBeUndefined();
  });
});

describe("visibleJobs — reverse chronological, capped", () => {
  it("shows the newest JOBS_MAX_ROWS first, oldest dropped", () => {
    const rows = Array.from({ length: 8 }, (_, i) => job({ id: `bg_${i}`, startedAt: 1000 + i }));
    const shown = visibleJobs(rows);
    expect(shown).toHaveLength(JOBS_MAX_ROWS);
    expect(shown.map((j) => j.id)).toEqual(["bg_7", "bg_6", "bg_5", "bg_4", "bg_3"]);
  });

  it("keeps full order for a short list", () => {
    const rows = [job({ id: "bg_a", startedAt: 5 }), job({ id: "bg_b", startedAt: 9 })];
    expect(visibleJobs(rows).map((j) => j.id)).toEqual(["bg_b", "bg_a"]);
  });
});
