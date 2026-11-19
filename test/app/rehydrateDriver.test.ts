import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getState, resetForTests, setState } from "../../src/core/store.ts";
import { clearRehydrate, driveRehydrate, stageRehydrate } from "../../src/app/transcriptRebuild.ts";
import { placeholderLogEntries } from "../../src/core/turnPresenter.ts";
import { toTranscriptEntries } from "../../src/core/transcript.ts";
import type { LogEntry } from "../../src/core/entries.ts";
import type { TranscriptMessage, TranscriptResult } from "../../src/yogClient.ts";

function row(o: Partial<TranscriptMessage>): TranscriptMessage {
  return { seq: 1, role: "user", content: "hello", ...o } as TranscriptMessage;
}

function dump(n: number, contents?: (i: number) => Partial<TranscriptMessage>): TranscriptResult {
  const messages = Array.from({ length: n }, (_, i) => ({
    seq: i + 1,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `msg ${i}`,
    ...contents?.(i),
  }));
  return { sessionId: "s1", status: "idle", messages } as unknown as TranscriptResult;
}

/** Seed the log the way the app does: startup notes first, then one
 *  placeholder per transcript row. */
function seedLog(d: TranscriptResult, notes: number): void {
  const head: LogEntry[] = Array.from({ length: notes }, (_, i) => ({
    kind: "notice",
    lines: [`note ${i}`],
  }));
  const placeholders = placeholderLogEntries(toTranscriptEntries(d.messages), 80);
  setState({ entries: [...head, ...placeholders] });
}

async function drain(): Promise<void> {
  for (let i = 0; i < 10_000 && getState().entries.some((e) => e.kind === "placeholder"); i++) {
    await vi.runAllTimersAsync();
  }
}

describe("rehydrate driver (bottom-up swap)", () => {
  beforeEach(() => {
    resetForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    clearRehydrate();
    vi.useRealTimers();
  });

  it("swaps every placeholder, seed notes offsetting the log positions", async () => {
    const d = dump(400);
    seedLog(d, 3); // startup notes shift every placeholder position by 3
    stageRehydrate(d);
    driveRehydrate();
    await drain();
    const log = getState().entries;
    expect(log.filter((e) => e.kind === "placeholder")).toHaveLength(0);
    expect(log).toHaveLength(3 + 400);
    // Spot-check the alignment: row i's real entry carries its content.
    expect(log[3]?.lines).toEqual(["msg 0"]);
    expect(log[3 + 399]?.lines).toEqual(["msg 399"]);
  });

  it("pairs call+result rows into one swap group across the offset", async () => {
    const d = dump(2);
    const messages = d.messages as TranscriptMessage[];
    messages[1] = row({
      seq: 2,
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
    });
    const withTool = {
      ...d,
      messages: [
        messages[0],
        messages[1],
        row({ seq: 3, role: "tool", name: "bash", content: '{"exitCode":0}' }),
      ],
    } as TranscriptResult;
    seedLog(withTool, 1);
    stageRehydrate(withTool);
    driveRehydrate();
    await drain();
    const log = getState().entries;
    expect(log.filter((e) => e.kind === "placeholder")).toHaveLength(0);
    // The call row's group: the ⚙️ call line, the ✅ result line, then the
    // result block — the same shapes the live turn path produces.
    expect(log.map((e) => e.kind)).toEqual(["notice", "user", "tool", "tool", "toolResult"]);
    expect(log[2]?.lines[0]).toContain("⚙️");
    expect(log[3]?.lines[0]).toContain("✅");
    expect(log[4]?.lines[0]).toContain("exitCode");
  });
});
