/**
 * The busy seam covers the WHOLE host surface (#144, hole 4): the
 * presenter's prose stream and tool handlers mutate `host.entries`
 * directly — a wrapper around `append` alone let wake prose interleave
 * with the user's turn. Pinned here: while busy, the shared log is
 * untouched and the presenter's scratch work collects; the flush lands
 * it in arrival order after the user's content.
 */
import { afterEach, describe, expect, it } from "vitest";

import { deferWhileBusy, type IdleWatchHost } from "../../src/app/index.ts";
import { createTurnPresenter, getState, resetForTests, setState } from "../../src/core/index.ts";
import type { LogEntry } from "../../src/core/index.ts";

afterEach(() => {
  resetForTests();
});

/** The composition root's host shape: LIVE entries binding (the real one
 *  reads the store; here a plain array), append through pushLines. */
function hostOf(log: LogEntry[]): IdleWatchHost {
  return {
    get entries() {
      return log;
    },
    append: (kind, lines) => void log.push({ kind, lines } as LogEntry),
    width: () => 80,
    requestRender: () => undefined,
    nextMessageSeq: () => "1",
  } as IdleWatchHost;
}

describe("deferWhileBusy — the whole host surface defers", () => {
  it("wake prose + tools collect while busy; flush lands them in order", () => {
    setState({ busy: true });
    const log: LogEntry[] = [];
    const seam = deferWhileBusy(hostOf(log), () => getState().busy);
    const presenter = createTurnPresenter(seam.host);
    // A foreign wake turn streams while the user's turn is busy:
    presenter.events.onStarted?.("t1", "m", true);
    presenter.events.onDelta?.("wake prose streams… ");
    presenter.events.onDelta?.("and more.");
    presenter.events.onToolCall?.("c1", "bash", { command: "ls" });
    presenter.events.onToolResult?.({ id: "c1", name: "bash", ok: true, result: { exitCode: 0 } });
    // Nothing touched the shared log:
    expect(log.length).toBe(0);
    // The scratch array holds the work (3 entries: prose, call+result
    // pair, summary-on-finish not fired here):
    expect(seam.host.entries.length).toBe(3);
    // The seam: busy → false, flush lands the batch in arrival order.
    setState({ busy: false });
    seam.flush();
    expect(log.map((e) => e.kind)).toEqual(["assistant", "tool", "toolResult"]);
    expect((log[0] as LogEntry).lines.join("")).toContain("wake prose streams…");
  });

  it("idle appends pass straight through (no buffering when not busy)", () => {
    setState({ busy: false });
    const log: LogEntry[] = [];
    const seam = deferWhileBusy(hostOf(log), () => getState().busy);
    seam.host.append("notice", ["⏳ background jobs", "delivering"]);
    expect(log.length).toBe(1);
    expect(seam.host.entries.length).toBe(1);
  });
});
