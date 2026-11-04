import { describe, expect, it } from "vitest";

import {
  annotateToolCall,
  createTurnPresenter,
  toolCallEntry,
  toolResultChunk,
  transcriptLogEntries,
} from "../../src/core/turnPresenter.ts";
import { toTranscriptEntries } from "../../src/core/transcript.ts";
import type { TranscriptMessage } from "../../src/yogClient.ts";
import type { LogEntry } from "../../src/core/entries.ts";
import { parseToolArgs } from "../../src/yogClient.ts";

/** Column width used across these tests. */
const COLS = 80;

/** A transcript row with defaults and overrides. */
function row(overrides: Partial<TranscriptMessage>): TranscriptMessage {
  return { seq: 1, role: "user", content: "hello", ...overrides };
}

describe("toolCallEntry", () => {
  it("builds the ⚙️ call line with compact + full args", () => {
    const entry = toolCallEntry("c1", "bash", parseToolArgs('{"cmd":"ls"}'), COLS);
    expect(entry.kind).toBe("tool");
    expect(entry.label).toBe("⚙️ bash");
    expect(entry.argsCompact).toContain("ls");
    expect(entry.full).toBe('{\n  "cmd": "ls"\n}');
    expect(entry.expanded).toBe(false);
  });

  it("omits args from the line when there are none", () => {
    const entry = toolCallEntry("c1", "bash", undefined, COLS);
    expect(entry.label).toBe("⚙️ bash");
    expect(entry.argsCompact).toBeUndefined();
    expect(entry.lines[0]).toBe("⚙️ bash");
  });

  it("falls back to a generic label for a nameless call", () => {
    const entry = toolCallEntry("c1", "", {}, COLS);
    expect(entry.label).toBe("⚙️ tool");
  });
});

describe("annotateToolCall", () => {
  it("appends ✅ into the label and rebuilds the collapsed line", () => {
    const entry = toolCallEntry("c1", "bash", parseToolArgs('{"cmd":"ls"}'), COLS);
    annotateToolCall(entry, true);
    expect(entry.label).toBe("⚙️ bash ✅");
    expect(entry.lines[0]).toBe(`⚙️ bash ✅ ${entry.argsCompact}`);
  });

  it("appends ❌ with the failure detail", () => {
    const entry = toolCallEntry("c1", "bash", undefined, COLS);
    annotateToolCall(entry, false, "boom");
    expect(entry.label).toBe("⚙️ bash ❌ boom");
    expect(entry.lines[0]).toBe("⚙️ bash ❌ boom");
  });

  it("annotates the bare line when no label exists", () => {
    const entry: LogEntry = { kind: "tool", lines: ["raw line"] };
    annotateToolCall(entry, false);
    expect(entry.lines[0]).toBe("raw line ❌ failed");
  });
});

describe("toolResultChunk", () => {
  it("renders a bash-shaped result as text with the exit status", () => {
    const chunk = toolResultChunk("bash", { exitCode: 0, runtimeMs: 42, stdout: "out\n" });
    expect(chunk.kind).toBe("chunk");
    expect(chunk.collapsed).toBe(true);
    expect(chunk.lines[0]).toBe("bash → exit 0 · 42ms");
    // The body is the RAW result — the renderer expands it to display rows.
    expect(chunk.result).toEqual({ exitCode: 0, runtimeMs: 42, stdout: "out\n" });
  });

  it("renders a status-only result with its raw payload", () => {
    const chunk = toolResultChunk("bash", { exitCode: 0, runtimeMs: 1 });
    expect(chunk.lines[0]).toBe("bash → exit 0 · 1ms");
    // The body is the raw result; the renderer turns it into rows.
    expect(chunk.result).toEqual({ exitCode: 0, runtimeMs: 1 });
  });
});

/** Host that records appended log entries. */
function makeHost() {
  const entries: LogEntry[] = [];
  const appended: LogEntry[] = [];
  const host = {
    entries,
    append: (kind: LogEntry["kind"], lines: string[]) => {
      const e: LogEntry = { kind, lines };
      entries.push(e);
      appended.push(e);
    },
    width: () => COLS,
    requestRender: () => {},
  };
  return { host, entries, appended };
}

describe("createTurnPresenter", () => {
  it("appends the user entry on begin() and resets streaming on finish()", () => {
    const { host, entries } = makeHost();
    const turn = createTurnPresenter(host);
    turn.begin("hi");
    expect(entries.at(-1)).toEqual({ kind: "user", lines: ["hi"] });
    turn.events.onDelta?.("hello");
    turn.finish();
    const assistant = entries.find((e) => e.kind === "assistant");
    expect(assistant?.streaming).toBe(false);
    expect(assistant?.lines.join("")).toBe("hello");
  });

  it("pairs tool calls with results via annotate (✅ lands in the label)", () => {
    const { host, entries } = makeHost();
    const turn = createTurnPresenter(host);
    turn.events.onToolCall?.("c1", "bash", parseToolArgs('{"cmd":"ls"}'));
    turn.events.onToolResult?.("c1", "bash", true, { exitCode: 0, stdout: "out\n" });
    const call = entries.find((e) => e.kind === "tool");
    expect(call?.label).toBe("⚙️ bash ✅");
    const chunk = entries.find((e) => e.kind === "chunk");
    expect(chunk?.lines[0]).toBe("bash → exit 0");
  });

  it("logs an error event as an error entry", () => {
    const { host, entries } = makeHost();
    const turn = createTurnPresenter(host);
    turn.events.onError?.("boom_code", "bad");
    expect(entries.at(-1)).toEqual({ kind: "error", lines: ["boom_code: bad"] });
  });

  it("logs the abort as a notice entry with a shortened reason", () => {
    const { host, entries } = makeHost();
    const turn = createTurnPresenter(host);
    turn.events.onAborted?.("turn aborted by operator");
    expect(entries.at(-1)).toEqual({
      kind: "notice",
      lines: ["⏹️ turn aborted", "by operator"],
    });
  });

  it("keeps an unrecognized abort reason as the notice detail", () => {
    const { host, entries } = makeHost();
    const turn = createTurnPresenter(host);
    turn.events.onAborted?.("worker pool exploded");
    expect(entries.at(-1)).toEqual({
      kind: "notice",
      lines: ["⏹️ turn aborted", "worker pool exploded"],
    });
  });

  it("tolerates an empty abort reason", () => {
    const { host, entries } = makeHost();
    const turn = createTurnPresenter(host);
    turn.events.onAborted?.("");
    expect(entries.at(-1)?.lines).toEqual(["⏹️ turn aborted", ""]);
  });

  it("logs a max_rounds stop as a notice entry with a cap summary", () => {
    const { host, entries } = makeHost();
    const turn = createTurnPresenter(host);
    turn.events.onFinish?.(9500, "max_rounds");
    expect(entries.at(-1)).toEqual({
      kind: "notice",
      lines: ["⏹️ turn stopped", "reached the tool-round cap after 10s"],
    });
  });

  it("logs no notice for a natural finish (no stopReason)", () => {
    const { host, entries } = makeHost();
    const turn = createTurnPresenter(host);
    turn.events.onFinish?.(1200, undefined);
    expect(entries.filter((e) => e.kind === "notice")).toHaveLength(0);
  });

  it("logs a per-turn token notice when usage arrives on a natural finish", () => {
    const { host, entries } = makeHost();
    const turn = createTurnPresenter(host);
    turn.events.onFinish?.(1200, undefined, {
      prompt_tokens: 1234,
      completion_tokens: 567,
      total_tokens: 1801,
    });
    expect(entries.at(-1)).toEqual({
      kind: "notice",
      lines: ["⏹️ turn finished", "tokens: 1,234 prompt · 567 completion · 1,801 total"],
    });
  });

  it("appends tokens to the max_rounds notice detail", () => {
    const { host, entries } = makeHost();
    const turn = createTurnPresenter(host);
    turn.events.onFinish?.(9500, "max_rounds", {
      prompt_tokens: 1234,
      completion_tokens: 567,
      total_tokens: 1801,
    });
    expect(entries.at(-1)).toEqual({
      kind: "notice",
      lines: [
        "⏹️ turn stopped",
        "reached the tool-round cap after 10s · tokens: 1,234 prompt · 567 completion · 1,801 total",
      ],
    });
  });

  it("emits no token notice when usage is empty or all-non-numeric", () => {
    const { host, entries } = makeHost();
    const turn = createTurnPresenter(host);
    turn.events.onFinish?.(1200, undefined, {});
    turn.events.onFinish?.(1200, undefined, { prompt_tokens: "nope" as unknown as number });
    expect(entries.filter((e) => e.kind === "notice")).toHaveLength(0);
  });

  it("emits no result chunk for a failed call — the ❌ line is the whole failure", () => {
    const { host, entries } = makeHost();
    const turn = createTurnPresenter(host);
    turn.events.onToolCall?.("c1", "bash", parseToolArgs('{"cmd":"ls"}'));
    turn.events.onToolResult?.("c1", "bash", false, { error: "boom" }, "boom");
    const call = entries.find((e) => e.kind === "tool");
    expect(call?.label).toBe("⚙️ bash ❌ boom");
    expect(entries.filter((e) => e.kind === "chunk")).toHaveLength(0);
  });

  it("starts a fresh prose block after tool activity (no replayed text)", () => {
    const { host, entries } = makeHost();
    const turn = createTurnPresenter(host);
    turn.begin("check it");
    turn.events.onDelta?.("first prose");
    turn.events.onToolCall?.("c1", "bash", parseToolArgs('{"cmd":"ls"}'));
    turn.events.onToolResult?.("c1", "bash", true, { exitCode: 0, stdout: "out\n" });
    turn.events.onDelta?.("second prose");
    turn.finish();
    const prose = entries.filter((e) => e.kind === "assistant");
    // Two distinct blocks: pre-tool and post-tool prose, each holding only
    // its own text.
    expect(prose).toHaveLength(2);
    expect(prose[0]?.lines.join("")).toBe("first prose");
    expect(prose[1]?.lines.join("")).toBe("second prose");
    expect(prose[0]).not.toBe(prose[1]);
    expect(prose.every((e) => e.streaming === false)).toBe(true);
  });

  it("keeps streaming into one block while prose is the log tail", () => {
    const { host, entries } = makeHost();
    const turn = createTurnPresenter(host);
    turn.begin("q");
    turn.events.onDelta?.("hel");
    turn.events.onDelta?.("lo");
    turn.finish();
    const prose = entries.filter((e) => e.kind === "assistant");
    expect(prose).toHaveLength(1);
    expect(prose[0]?.lines.join("")).toBe("hello");
  });

  it("emits nothing for an empty delta — no empty prose block before tool calls", () => {
    const { host, entries } = makeHost();
    const turn = createTurnPresenter(host);
    turn.begin("q");
    turn.events.onDelta?.("");
    turn.events.onDelta?.("   ");
    turn.events.onToolCall?.("c1", "bash", parseToolArgs('{"cmd":"ls"}'));
    turn.events.onToolResult?.("c1", "bash", true, { exitCode: 0, stdout: "out\n" });
    turn.finish();
    expect(entries.filter((e) => e.kind === "assistant")).toHaveLength(0);
  });
});

describe("transcriptLogEntries", () => {
  it("renders plain rows as user/assistant/system entries", () => {
    const out = transcriptLogEntries(
      toTranscriptEntries([
        row({ role: "user", content: "q" }),
        row({ role: "assistant", content: "a" }),
        row({ role: "system", content: "s" }),
      ]),
      COLS,
    );
    expect(out.map((e) => [e.kind, e.lines[0]])).toEqual([
      ["user", "q"],
      ["assistant", "a"],
      ["system", "s"],
    ]);
  });

  it("rehydrates call+result rows as annotated call lines and chunks", () => {
    const out = transcriptLogEntries(
      toTranscriptEntries([
        row({ seq: 1, role: "user", content: "run ls" }),
        row({
          seq: 2,
          role: "assistant",
          toolCalls: [
            { id: "c1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } },
          ],
        }),
        row({
          seq: 3,
          role: "tool",
          toolCallId: "c1",
          name: "bash",
          content: '{"exitCode":0,"stdout":"out\\n"}',
        }),
      ]),
      COLS,
    );
    expect(out.map((e) => e.kind)).toEqual(["user", "tool", "chunk"]);
    const call = out[1] as LogEntry & { label?: string };
    expect(call.label).toBe("⚙️ bash ✅");
    expect(call.full).toBe('{\n  "cmd": "ls"\n}');
    const chunk = out[2] as LogEntry & { lines: string[]; result?: unknown };
    expect(chunk.lines[0]).toBe("bash → exit 0");
    // The body is the RAW result — the renderer expands it to rows.
    expect(chunk.result).toEqual({ exitCode: 0, stdout: "out\n" });
  });

  it("pairs multiple calls with their results by toolCallId", () => {
    const out = transcriptLogEntries(
      toTranscriptEntries([
        row({
          seq: 1,
          role: "assistant",
          toolCalls: [
            { id: "c1", type: "function", function: { name: "bash", arguments: "{}" } },
            { id: "c2", type: "function", function: { name: "read", arguments: "{}" } },
          ],
        }),
        row({ seq: 2, role: "tool", toolCallId: "c1", name: "bash", content: '{"exitCode":0}' }),
        row({
          seq: 3,
          role: "tool",
          toolCallId: "c2",
          name: "read",
          content: '{"error":"no file"}',
        }),
      ]),
      COLS,
    );
    expect(out.filter((e) => e.kind === "tool")).toHaveLength(2);
    const calls = out.filter((e) => e.kind === "tool") as Array<LogEntry & { label?: string }>;
    expect(calls[0]?.label).toBe("⚙️ bash ✅");
    expect(calls[1]?.label).toBe("⚙️ read ❌ no file");
  });

  it("keeps bare call lines when no result row follows", () => {
    const out = transcriptLogEntries(
      toTranscriptEntries([
        row({
          seq: 1,
          role: "assistant",
          toolCalls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
        }),
      ]),
      COLS,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("tool");
    expect((out[0] as LogEntry & { label?: string }).label).toBe("⚙️ bash");
  });

  it("pairs a failed result row without emitting a chunk", () => {
    const out = transcriptLogEntries(
      toTranscriptEntries([
        row({
          seq: 1,
          role: "assistant",
          toolCalls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
        }),
        row({ seq: 2, role: "tool", toolCallId: "c1", name: "bash", content: '{"error":"boom"}' }),
      ]),
      COLS,
    );
    expect(out.map((e) => e.kind)).toEqual(["tool"]);
    expect((out[0] as LogEntry & { label?: string }).label).toBe("⚙️ bash ❌ boom");
  });

  it("renders an orphan SUCCESS result row as a standalone line + chunk", () => {
    const out = transcriptLogEntries(
      toTranscriptEntries([
        row({ seq: 1, role: "tool", toolCallId: "cx", name: "bash", content: '{"exitCode":0}' }),
      ]),
      COLS,
    );
    expect(out.map((e) => e.kind)).toEqual(["tool", "chunk"]);
    expect(out[0]?.lines[0]).toBe("✅ bash");
  });

  it("renders an orphan FAILED result row as a bare error line (no chunk)", () => {
    const out = transcriptLogEntries(
      toTranscriptEntries([
        row({ seq: 1, role: "tool", toolCallId: "cx", name: "bash", content: '{"error":"boom"}' }),
      ]),
      COLS,
    );
    expect(out.map((e) => e.kind)).toEqual(["tool"]);
    expect(out[0]?.lines[0]).toBe("❌ bash boom");
  });

  it("tolerates unknown roles mixed with plain rows", () => {
    const out = transcriptLogEntries(
      toTranscriptEntries([
        row({ role: "mystery" as "user", content: "?" }),
        row({ role: "user", content: "still works" }),
      ]),
      COLS,
    );
    expect(out.map((e) => e.lines[0])).toEqual(["?", "still works"]);
  });
});
