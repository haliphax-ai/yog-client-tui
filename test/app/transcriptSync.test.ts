/**
 * The submit-time transcript sync (#135): the probe compares the store's
 * record of the last rebuild against a fresh `transcript.get` dump, and
 * the submit path awaits it before the turn starts. The three behaviors
 * the issue pins: unchanged → no-op; advanced → chrome-preserving
 * rebuild; probe failure → debug note, submit proceeds.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetForTests, setState, getState } from "../../src/core/index.ts";
import type { YogClient } from "../../src/client/index.ts";
import { setTranscriptSyncNotes, syncTranscriptOnSubmit } from "../../src/app/index.ts";
import { emitDebug, isDebugEnabled } from "../../src/ui/index.ts";
import type { TranscriptMessage, TranscriptResult } from "../../src/client/index.ts";
import { noticeLine } from "../../src/core/index.ts";
import type { LogEntry } from "../../src/core/index.ts";

/** The client surface the sync needs (only `getTranscript`); the sync's
 *  parameter is the concrete client, so tests cast the stub to it. */
type SyncClient = Pick<import("../../src/client/index.ts").YogClient, "getTranscript">;

/** The stub typed as the concrete client (the sync calls one method). */
function stubClient(getTranscript: SyncClient["getTranscript"]): YogClient {
  return { getTranscript } as unknown as YogClient;
}

function dump(rows: TranscriptMessage[]): TranscriptResult {
  return { sessionId: "s1", status: "idle", messages: rows } as unknown as TranscriptResult;
}

function row(o: Partial<TranscriptMessage>): TranscriptMessage {
  return { seq: 1, role: "user", content: "hello", ...o } as TranscriptMessage;
}

/** A log holding the chrome + the stamp shapes the rebuild paths leave:
 *  startup notes first, then one `String(seq)`-stamped entry per row. */
function seededLog(rows: TranscriptMessage[]): void {
  const head: LogEntry[] = [{ kind: "notice", lines: noticeLine("notice", "connected", "test") }];
  const entries = head.concat(
    rows.map((m) => ({
      kind: m.role === "user" ? ("user" as const) : ("assistant" as const),
      lines: [(m.content ?? "") as string],
      copyIds: { itemId: String(m.seq) },
    })),
  );
  setState({ entries });
}

beforeEach(() => {
  resetForTests();
  setTranscriptSyncNotes([{ kind: "notice", lines: noticeLine("notice", "connected", "test") }]);
});

describe("syncTranscriptOnSubmit", () => {
  it("is a no-op when the transcript has not advanced", async () => {
    const rows = [row({ seq: 1 }), row({ seq: 2, role: "assistant", content: "hi" })];
    seededLog(rows);
    const before = getState().entries;
    const getTranscript = vi.fn(async () => dump(rows));
    await syncTranscriptOnSubmit(stubClient(getTranscript));
    expect(getTranscript).toHaveBeenCalledTimes(1);
    expect(getState().entries.map((e) => e.kind)).toEqual(before.map((e) => e.kind));
    expect(getState().entries.map((e) => e.lines.join(""))).toEqual(
      before.map((e) => e.lines.join("")),
    );
  });

  it("rebuilds the log under the startup notes when rows advanced", async () => {
    seededLog([row({ seq: 1 })]);
    const note: LogEntry = { kind: "notice", lines: noticeLine("notice", "new session", "s1") };
    setTranscriptSyncNotes([note]);
    const advanced = dump([
      row({ seq: 1 }),
      row({ seq: 2, role: "assistant", content: "wake reply" }),
    ]);
    await syncTranscriptOnSubmit(stubClient(async () => advanced));
    const log = getState().entries;
    // Chrome first, then the full conversion (one entry per row).
    expect(log[0]).toEqual(note);
    expect(log.slice(1).map((e) => e.lines.join(""))).toEqual(["hello", "wake reply"]);
  });

  it("replaces the status-bar total with the dump's weight", async () => {
    seededLog([row({ seq: 1 })]);
    setState({ tokenTotals: { prompt: 0, completion: 0, total: 0 } });
    const advanced = dump([
      row({ seq: 1 }),
      row({ seq: 2, role: "assistant", content: "wake reply" }),
    ]);
    await syncTranscriptOnSubmit(stubClient(async () => advanced));
    // No per-turn usage in the dump: the tokenx estimate over the rows.
    expect(getState().tokenTotals.total).toBeGreaterThan(0);
  });

  it("proceeds with a debug note when the probe fails", async () => {
    seededLog([row({ seq: 1 })]);
    const before = getState().entries;
    const prevDebug = process.env.YOG_DEBUG;
    process.env.YOG_DEBUG = "1";
    try {
      await syncTranscriptOnSubmit(
        stubClient(async () => {
          throw new Error("probe down");
        }),
      );
    } finally {
      if (prevDebug === undefined) delete process.env.YOG_DEBUG;
      else process.env.YOG_DEBUG = prevDebug;
    }
    expect(getState().entries).toEqual(before); // nothing rebuilt
  });

  it("the failure path is silent with debug off (the entries stay)", async () => {
    seededLog([row({ seq: 1 })]);
    const before = getState().entries;
    await syncTranscriptOnSubmit(
      stubClient(async () => {
        throw new Error("probe down");
      }),
    );
    expect(isDebugEnabled()).toBe(false);
    expect(getState().entries).toEqual(before); // nothing rebuilt, nothing shown
  });

  it("the failure path emits the skip note into the debug chunk", async () => {
    seededLog([row({ seq: 1 })]);
    const prevDebug = process.env.YOG_DEBUG;
    process.env.YOG_DEBUG = "1";
    try {
      await syncTranscriptOnSubmit(
        stubClient(async () => {
          throw new Error("probe down");
        }),
      );
      const last = getState().entries.at(-1);
      expect(last?.kind).toBe("debug");
      expect(last?.lines.join("\n")).toContain("transcript sync skipped: probe down");
    } finally {
      if (prevDebug === undefined) delete process.env.YOG_DEBUG;
      else process.env.YOG_DEBUG = prevDebug;
    }
  });

  it("emitDebug stays a no-op with the key logger off (the real default)", () => {
    expect(isDebugEnabled()).toBe(false);
    const before = getState().entries;
    emitDebug(["unreachable"]);
    expect(getState().entries).toBe(before);
  });
});
