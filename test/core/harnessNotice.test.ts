import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HARNESS_NOTICE_TOOL,
  decodeHarnessNotices,
  harnessNoticeEntries,
  harnessNoticesShown,
  isHarnessNoticeTool,
  setHarnessNoticesVisible,
  type HarnessNotice,
} from "../../src/core/index.ts";
import {
  toTranscriptEntries,
  transcriptLogEntries,
  rehydrateGroups,
} from "../../src/core/index.ts";
import type { TranscriptMessage } from "../../src/client/index.ts";
import type { LogEntry } from "../../src/core/index.ts";
import { createTurnPresenter, resetForTests } from "../../src/core/index.ts";

/** A transcript row builder (seq defaults past the given rows). */
function row(o: Partial<TranscriptMessage>, seq = 1): TranscriptMessage {
  return { seq, role: "user", content: "hello", ...o } as TranscriptMessage;
}

/** The synthetic call row (empty args, one `harness_notice` call). */
function harnessCall(id: string, seq: number): TranscriptMessage {
  return {
    seq,
    role: "assistant",
    content: null as unknown as string,
    toolCalls: [{ id, type: "function", function: { name: HARNESS_NOTICE_TOOL, arguments: "{}" } }],
  };
}

/** The paired result row: `{hint, notices}` as serialized content. */
function harnessResult(id: string, seq: number, notices: HarnessNotice[]): TranscriptMessage {
  return {
    seq,
    role: "tool",
    toolCallId: id,
    name: HARNESS_NOTICE_TOOL,
    content: JSON.stringify({ hint: "synthetic harness message", notices }),
  };
}

afterEach(() => {
  setHarnessNoticesVisible(true);
});

describe("decodeHarnessNotices", () => {
  it("decodes a well-formed payload", () => {
    const notices = decodeHarnessNotices({
      hint: "synthetic",
      notices: [{ kind: "background-jobs", body: "job bg_1 finished ✅" }],
    });
    expect(notices).toEqual([{ kind: "background-jobs", body: "job bg_1 finished ✅" }]);
  });

  it("rejects ordinary tool results (no hint/notices shape)", () => {
    expect(decodeHarnessNotices({ exitCode: 0, stdout: "hi" })).toBeUndefined();
    expect(decodeHarnessNotices({ notices: [{ kind: "x" }] })).toBeUndefined();
    expect(decodeHarnessNotices("plain text")).toBeUndefined();
    expect(decodeHarnessNotices(null)).toBeUndefined();
  });

  it("rejects malformed notice entries", () => {
    expect(decodeHarnessNotices({ hint: "h", notices: [{ kind: 1, body: "b" }] })).toBeUndefined();
    expect(decodeHarnessNotices({ hint: "h", notices: ["nope"] })).toBeUndefined();
  });
});

describe("isHarnessNoticeTool", () => {
  it("matches the reserved synthetic name only", () => {
    expect(isHarnessNoticeTool("harness_notice")).toBe(true);
    expect(isHarnessNoticeTool("bash")).toBe(false);
    expect(isHarnessNoticeTool("")).toBe(false);
  });
});

describe("harnessNoticeEntries", () => {
  beforeEach(() => {
    setHarnessNoticesVisible(true);
  });

  it("renders one notice entry per notice (kind label + body)", () => {
    const entries = harnessNoticeEntries([
      { kind: "background-jobs", body: "background jobs terminated: bg_1, bg_2" },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("notice");
    expect(entries[0]!.harness).toBe(true);
    // The emoji-carrying label: kinds keep their own identity via the
    // notice system; the body rides line 2 (dimmed by the renderer).
    expect(entries[0]!.lines.join(" ")).toContain("background-jobs");
    expect(entries[0]!.lines.join(" ")).toContain("bg_1, bg_2");
  });

  it("emits nothing while the toggle hides notices", () => {
    setHarnessNoticesVisible(false);
    expect(harnessNoticesShown()).toBe(false);
    expect(harnessNoticeEntries([{ kind: "background-jobs", body: "x" }])).toEqual([]);
  });
});

describe("rehydration: the harness pair renders as notices", () => {
  beforeEach(() => {
    setHarnessNoticesVisible(true);
  });

  it("replaces the call+result rows with notice lines (flat conversion)", () => {
    const rows = [
      row({ role: "user", content: "do a thing" }, 1),
      harnessCall("call_hn_1", 2),
      harnessResult("call_hn_1", 3, [{ kind: "background-jobs", body: "terminated: bg_9" }]),
      row({ role: "assistant", content: "done ✅" }, 4),
    ];
    const entries = transcriptLogEntries(toTranscriptEntries(rows), 80);
    const kinds = entries.map((e) => e.kind);
    expect(kinds).toEqual(["user", "notice", "assistant"]);
    const notice = entries[1] as LogEntry;
    expect(notice.harness).toBe(true);
    expect(notice.lines.join(" ")).toContain("terminated: bg_9");
  });

  it("the attached tool result renders the shared chunk on rehydrate too", () => {
    const rows = [
      harnessCall("call_hn_4", 1),
      harnessResult("call_hn_4", 2, [
        {
          kind: "background jobs",
          body: "job bg_2 finished · exit 0 · 7s",
          tool: "bash",
          result: { exitCode: 0, stdout: "rehydrate ok\n", stderr: "" },
        },
      ]),
    ];
    const entries = transcriptLogEntries(toTranscriptEntries(rows), 80);
    expect(entries.map((e) => e.kind)).toEqual(["notice", "chunk"]);
    expect(entries[0]!.harness).toBe(true);
    expect(entries[1]!.result).toEqual({ exitCode: 0, stdout: "rehydrate ok\n", stderr: "" });
    // Live-path copy parity: the chunk carries the call id as its item id.
    expect(entries[1]!.copyIds).toEqual({ itemId: "call_hn_4" });
  });

  it("the grouped walker produces the same shape (bottom-up parity)", () => {
    const rows = [
      harnessCall("call_hn_2", 1),
      harnessResult("call_hn_2", 2, [{ kind: "background-jobs", body: "hi ⚠️" }]),
    ];
    const groups = rehydrateGroups(toTranscriptEntries(rows), 80);
    const flat = groups.flat();
    expect(flat.map((e) => e.kind)).toEqual(["notice"]);
    expect(flat[0]!.harness).toBe(true);
  });

  it("a malformed harness payload falls through to the generic call step", () => {
    const rows = [
      harnessCall("call_hn_3", 1),
      {
        seq: 2,
        role: "tool",
        toolCallId: "call_hn_3",
        name: HARNESS_NOTICE_TOOL,
        content: JSON.stringify({ error: "not a notice payload" }),
      } as TranscriptMessage,
    ];
    const entries = transcriptLogEntries(toTranscriptEntries(rows), 80);
    // Generic tool path: the ⚙️ call line plus the ❌ annotation.
    expect(entries.map((e) => e.kind)).toEqual(["tool"]);
    expect(entries[0]!.lines[0]).toContain("harness_notice");
    expect(entries[0]!.lines[0]).toContain("❌");
  });

  it("an unknown tool named like a harness call (multi-call row) takes the generic path", () => {
    const rows = [
      {
        seq: 1,
        role: "assistant",
        content: null as unknown as string,
        toolCalls: [
          { id: "a", type: "function", function: { name: "bash", arguments: "{}" } },
          { id: "b", type: "function", function: { name: HARNESS_NOTICE_TOOL, arguments: "{}" } },
        ],
      } as TranscriptMessage,
    ];
    const entries = transcriptLogEntries(toTranscriptEntries(rows), 80);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]!.kind).toBe("tool");
  });
});
describe("live path: a harness_notice pair renders as notices", () => {
  beforeEach(() => {
    resetForTests();
  });
  afterEach(() => {
    setHarnessNoticesVisible(true);
  });

  it("onToolCall + onToolResult emit notice lines, not a 🔚 blob", () => {
    const host = {
      entries: [] as LogEntry[],
      append: (kind: LogEntry["kind"], lines: string[]) => {
        host.entries.push({ kind, lines });
      },
      width: () => 80,
      requestRender: () => undefined,
      nextMessageSeq: () => "1",
    };
    const presenter = createTurnPresenter(host);
    presenter.events.onToolCall?.("call_hn_9", HARNESS_NOTICE_TOOL, {});
    presenter.events.onToolResult?.({
      id: "call_hn_9",
      name: HARNESS_NOTICE_TOOL,
      ok: true,
      result: {
        hint: "synthetic",
        notices: [{ kind: "background-jobs", body: "aborted 2 jobs ✅" }],
      },
    });
    // No call row: all information lives in the result; the notices
    // replace both the call row and the result blob.
    const kinds = host.entries.map((e) => e.kind);
    expect(kinds).toEqual(["notice"]);
    expect(host.entries[0]!.harness).toBe(true);
    expect(host.entries[0]!.lines.join(" ")).toContain("aborted 2 jobs");
  });

  it("an attached tool result renders the shared result components", () => {
    const host = {
      entries: [] as LogEntry[],
      append: (kind: LogEntry["kind"], lines: string[]) => {
        host.entries.push({ kind, lines });
      },
      width: () => 80,
      requestRender: () => undefined,
      nextMessageSeq: () => "1",
    };
    const presenter = createTurnPresenter(host);
    presenter.events.onToolCall?.("call_hn_11", HARNESS_NOTICE_TOOL, {});
    presenter.events.onToolResult?.({
      id: "call_hn_11",
      name: HARNESS_NOTICE_TOOL,
      ok: true,
      result: {
        hint: "synthetic",
        notices: [
          {
            kind: "background jobs",
            body: "job bg_1 finished · exit 0 · 70s",
            tool: "bash",
            result: { exitCode: 0, stdout: "build ok\n", stderr: "" },
          },
        ],
      },
    });
    // The notice line first; then the bash-shaped result as the SAME
    // collapsible chunk a live bash call renders.
    const kinds = host.entries.map((e) => e.kind);
    expect(kinds).toEqual(["notice", "chunk"]);
    expect(host.entries[0]!.harness).toBe(true);
    expect(host.entries[0]!.lines.join(" ")).toContain("job bg_1 finished");
    expect(host.entries[1]!.result).toEqual({ exitCode: 0, stdout: "build ok\n", stderr: "" });
    expect(host.entries[1]!.copyIds).toEqual({ itemId: "call_hn_11" });
  });

  it("an orphan harness result renders its notices too", () => {
    const host = {
      entries: [] as LogEntry[],
      append: (kind: LogEntry["kind"], lines: string[]) => {
        host.entries.push({ kind, lines });
      },
      width: () => 80,
      requestRender: () => undefined,
      nextMessageSeq: () => "1",
    };
    const presenter = createTurnPresenter(host);
    presenter.events.onToolResult?.({
      id: "call_hn_10",
      name: HARNESS_NOTICE_TOOL,
      ok: true,
      result: { hint: "synthetic", notices: [{ kind: "background-jobs", body: "bg done" }] },
    });
    expect(host.entries.map((e) => e.kind)).toEqual(["notice"]);
  });
});

describe("the idle-abort prelude path (end-to-end shapes)", () => {
  it("a terminated-job notice decodes and renders through the rehydrate branch", () => {
    setHarnessNoticesVisible(true);
    // Exactly what the live server produced for an idle turn.abort with a
    // detached job: the prelude pair rides the NEXT turn's transcript.
    const rows = [
      {
        seq: 6,
        role: "assistant",
        content: null as unknown as string,
        toolCalls: [
          {
            id: "call_hn_bg",
            type: "function",
            function: { name: HARNESS_NOTICE_TOOL, arguments: "{}" },
          },
        ],
      } as TranscriptMessage,
      {
        seq: 7,
        role: "tool",
        toolCallId: "call_hn_bg",
        name: HARNESS_NOTICE_TOOL,
        content: JSON.stringify({
          hint: "synthetic harness message — not a real tool call",
          notices: [
            {
              kind: "background-jobs",
              body: "background jobs terminated: bg_6lnGeDtW3gy1xlCsqBKKAg",
            },
          ],
        }),
      } as TranscriptMessage,
    ];
    const entries = transcriptLogEntries(toTranscriptEntries(rows), 80);
    expect(entries.map((e) => e.kind)).toEqual(["notice"]);
    expect(entries[0]!.lines.join(" ")).toContain("background jobs terminated: bg_");
  });
});
