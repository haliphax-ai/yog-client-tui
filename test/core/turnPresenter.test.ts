import { describe, expect, it } from "vitest";

import {
  annotateToolCall,
  createTurnPresenter,
  toolCallEntry,
  toolResultChunk,
  toolResultEntry,
  toolResultEntries,
  transcriptLogEntries,
} from "../../src/core/turnPresenter.ts";
import type { TranscriptMessage, TokenUsage } from "../../src/yogClient.ts";
import { toTranscriptEntries } from "../../src/core/transcript.ts";
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

  it("stores args uncapped regardless of build width", () => {
    const entry = toolCallEntry(
      "c1",
      "bash",
      parseToolArgs(JSON.stringify({ cmd: "x".repeat(200) })),
      40,
    );
    expect(entry.argsCompact).toBe(`{"cmd":"${"x".repeat(200)}"}`);
    expect(entry.lines[0]).toBe(`⚙️ bash ${entry.argsCompact}`);
    const wide = toolCallEntry(
      "c1",
      "bash",
      parseToolArgs(JSON.stringify({ cmd: "x".repeat(200) })),
      120,
    );
    expect(wide.argsCompact).toBe(entry.argsCompact);
  });

  it("stores emoji args uncapped", () => {
    const entry = toolCallEntry(
      "c1",
      "bash",
      parseToolArgs(JSON.stringify({ cmd: "✅".repeat(50) })),
      40,
    );
    expect(entry.argsCompact).toContain("✅".repeat(50));
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
  it("keeps the header to execution facts (tokens were a fabricated per-call estimate)", () => {
    const chunk = toolResultChunk("bash", { stdout: "x", exitCode: 0 });
    expect(chunk.lines[0]).toBe("bash → exit 0");
  });

  it("omits the token segment for malformed/non-numeric token fields", () => {
    const chunk = toolResultChunk("bash", { tokens: "1234" });
    expect(chunk.lines[0]).toBe("bash →");
  });
});
describe("toolResultEntry / toolResultEntries", () => {
  it("builds a 🔚 call-style block with the result payload collapsed, expandable to full", () => {
    const entry = toolResultEntry("noop", { note: "did nothing", ok: true }, COLS);
    expect(entry.kind).toBe("toolResult");
    expect(entry.expanded).toBe(false);
    expect(entry.label).toBe("🔚 noop");
    expect(entry.argsCompact).toContain("did nothing");
    expect(entry.full).toContain('"note"');
    expect(entry.lines[0]).toBe(`${entry.label} ${entry.argsCompact}`);
  });

  it("stores the result payload UNCAPPED regardless of build width", () => {
    const entry = toolResultEntry("noop", { note: "y".repeat(200) }, 40);
    expect(entry.argsCompact).toBe(`{"note":"${"y".repeat(200)}"}`);
    expect(entry.argsCompact).not.toContain("…");
  });

  it("keeps the bash output chunk for bash-shaped results", () => {
    const entries = toolResultEntries("bash", { exitCode: 0, stdout: "hi", runtimeMs: 3 }, COLS);
    expect(entries.map((e) => e.kind)).toEqual(["chunk"]);
  });

  it("attaches the call's own status line for non-bash results with stats", () => {
    const entries = toolResultEntries("noop", { note: "ok", runtimeMs: 321 }, COLS);
    expect(entries.map((e) => e.kind)).toEqual(["toolResult", "status"]);
    expect(entries[1]?.lines[0]).toBe("runtime 321ms");
  });

  it("attaches no status line when the non-bash result has no stats", () => {
    const entries = toolResultEntries("noop", { note: "ok" }, COLS);
    expect(entries.map((e) => e.kind)).toEqual(["toolResult"]);
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
  it("splices the generic 🔚 result component + status line after a non-bash tool result", () => {
    const { host, entries } = makeHost();
    const turn = createTurnPresenter(host);
    turn.events.onToolCall?.("c1", "noop", parseToolArgs("{}"));
    turn.events.onToolResult?.("c1", "noop", true, {
      note: "did nothing",
      runtimeMs: 42,
    });
    const callIdx = entries.findIndex((e) => e.kind === "tool");
    expect(entries[callIdx + 1]?.kind).toBe("toolResult");
    expect((entries[callIdx + 1] as LogEntry & { label?: string }).label).toBe("🔚 noop");
    expect(entries[callIdx + 2]).toEqual({ kind: "status", lines: ["runtime 42ms"] });
  });

  it("logs an error event as an error entry", () => {
    const { host, entries } = makeHost();
    const turn = createTurnPresenter(host);
    turn.events.onError?.("boom_code", "bad");
    expect(entries.at(-1)).toEqual({
      kind: "error",
      lines: ["❌ turn error", "boom_code: bad"],
    });
  });

  it("logs the abort as a notice entry with a shortened reason", () => {
    const { host, entries } = makeHost();
    const turn = createTurnPresenter(host);
    turn.events.onAborted?.("turn aborted by operator");
    expect(entries.filter((e) => e.kind === "notice").at(-1)).toEqual({
      kind: "notice",
      lines: ["⏹️ turn aborted", "by operator"],
    });
    // The per-turn summary line follows the notice (no usage → no token seg).
    expect(entries.at(-1)).toEqual({ kind: "status", lines: ["0 tool calls"] });
  });

  it("keeps an unrecognized abort reason as the notice detail", () => {
    const { host, entries } = makeHost();
    const turn = createTurnPresenter(host);
    turn.events.onAborted?.("worker pool exploded");
    expect(entries.filter((e) => e.kind === "notice").at(-1)).toEqual({
      kind: "notice",
      lines: ["⏹️ turn aborted", "worker pool exploded"],
    });
    expect(entries.at(-1)).toEqual({ kind: "status", lines: ["0 tool calls"] });
  });

  it("tolerates an empty abort reason", () => {
    const { host, entries } = makeHost();
    const turn = createTurnPresenter(host);
    turn.events.onAborted?.("");
    // An empty reason drops the dot separator entirely (noticeLine trims it).
    expect(entries.find((e) => e.kind === "notice")?.lines).toEqual(["⏹️ turn aborted"]);
    expect(entries.at(-1)).toEqual({ kind: "status", lines: ["0 tool calls"] });
  });

  it("surfaces cut-point usage in the abort notice and the per-turn summary", () => {
    const { host, entries } = makeHost();
    const turn = createTurnPresenter(host);
    turn.events.onToolCall?.("c1", "bash", parseToolArgs('{"cmd":"ls"}'));
    turn.events.onToolResult?.("c1", "bash", true, { exitCode: 0 });
    turn.events.onAborted?.("turn aborted by operator", {
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
    });
    const notices = entries.filter((e) => e.kind === "notice");
    expect(notices.at(-1)).toEqual({
      kind: "notice",
      lines: [
        "⏹️ turn aborted",
        "by operator · tokens: 1,000 prompt · 500 completion · 1,500 total",
      ],
    });
    expect(entries.at(-1)).toEqual({
      kind: "status",
      lines: ["1 tool call · 1.5K tokens"],
    });
  });

  it("logs a max_rounds stop as a notice entry with a cap summary", () => {
    const { host, entries } = makeHost();
    const turn = createTurnPresenter(host);
    turn.events.onFinish?.(9500, "max_rounds");
    expect(entries.filter((e) => e.kind === "notice").at(-1)).toEqual({
      kind: "notice",
      lines: ["⏹️ turn stopped", "reached the tool-round cap after 10s"],
    });
    expect(entries.at(-1)).toEqual({
      kind: "status",
      lines: ["runtime 9s · 0 tool calls"],
    });
  });

  it("logs no notice for a natural finish (no stopReason)", () => {
    const { host, entries } = makeHost();
    const turn = createTurnPresenter(host);
    turn.events.onFinish?.(1200, undefined);
    expect(entries.filter((e) => e.kind === "notice")).toHaveLength(0);
  });

  it("stays quiet on the happy path — no notice, just the dark grey summary line", () => {
    const { host, entries } = makeHost();
    const turn = createTurnPresenter(host);
    turn.events.onFinish?.(1200, undefined, {
      prompt_tokens: 1234,
      completion_tokens: 567,
      total_tokens: 1801,
    });
    expect(entries.filter((e) => e.kind === "notice")).toHaveLength(0);
    expect(entries.at(-1)).toEqual({
      kind: "status",
      lines: ["runtime 1s · 0 tool calls · 1.8K tokens"],
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
    expect(entries.filter((e) => e.kind === "notice").at(-1)).toEqual({
      kind: "notice",
      lines: [
        "⏹️ turn stopped",
        "reached the tool-round cap after 10s · tokens: 1,234 prompt · 567 completion · 1,801 total",
      ],
    });
    // The per-turn summary line follows the notice and abbreviates the total.
    expect(entries.at(-1)).toEqual({
      kind: "status",
      lines: ["runtime 9s · 0 tool calls · 1.8K tokens"],
    });
  });

  it("emits no token notice when usage is empty or all-non-numeric", () => {
    const { host, entries } = makeHost();
    const turn = createTurnPresenter(host);
    turn.events.onFinish?.(1200, undefined, {});
    turn.events.onFinish?.(1200, undefined, { prompt_tokens: "nope" as unknown as number });
    expect(entries.filter((e) => e.kind === "notice")).toHaveLength(0);
  });
  it("counts only this turn's tool calls in the summary line", () => {
    const { host, entries } = makeHost();
    const turn = createTurnPresenter(host);
    turn.events.onToolCall?.("c1", "bash", parseToolArgs('{"cmd":"ls"}'));
    turn.events.onToolResult?.("c1", "bash", true, { exitCode: 0 });
    turn.events.onToolCall?.("c2", "bash", parseToolArgs('{"cmd":"pwd"}'));
    turn.events.onToolResult?.("c2", "bash", true, { exitCode: 0 });
    turn.events.onFinish?.(321_000, undefined);
    expect(entries.at(-1)).toEqual({
      kind: "status",
      lines: ["runtime 5m21s · 2 tool calls"],
    });
  });

  it("emits a fresh presenter per turn so totals never leak across turns", () => {
    const { host, entries } = makeHost();
    const first = createTurnPresenter(host);
    first.events.onToolCall?.("c1", "bash", parseToolArgs('{"cmd":"ls"}'));
    first.events.onToolResult?.("c1", "bash", true, { exitCode: 0 });
    first.events.onFinish?.(1000, undefined);
    const second = createTurnPresenter(host);
    second.events.onFinish?.(1000, undefined, {
      prompt_tokens: 500,
      completion_tokens: 250,
      total_tokens: 750,
    });
    const firstStatus = entries.filter((e) => e.kind === "status")[0];
    const secondStatus = entries.filter((e) => e.kind === "status")[1];
    expect(firstStatus?.lines[0]).toBe("runtime 1s · 1 tool call");
    expect(secondStatus?.lines[0]).toBe("runtime 1s · 0 tool calls · 750 tokens");
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

  it("renders an orphan SUCCESS result row with the generic 🔚 component for non-bash tools", () => {
    const out = transcriptLogEntries(
      toTranscriptEntries([
        row({
          seq: 1,
          role: "tool",
          toolCallId: "cx",
          name: "noop",
          content: '{"note":"did nothing"}',
        }),
      ]),
      COLS,
    );
    expect(out.map((e) => e.kind)).toEqual(["tool", "toolResult"]);
    expect(out[0]?.lines[0]).toBe("✅ noop");
    expect((out[1] as LogEntry & { label?: string }).label).toBe("🔚 noop");
  });

  it("renders an orphan SUCCESS result row as a standalone line + chunk for bash-shaped results", () => {
    const out = transcriptLogEntries(
      toTranscriptEntries([
        row({
          seq: 1,
          role: "tool",
          toolCallId: "cx",
          name: "bash",
          content: '{"exitCode":0,"stdout":"hi"}',
        }),
      ]),
      COLS,
    );
    expect(out.map((e) => e.kind)).toEqual(["tool", "chunk"]);
    expect(out[0]?.lines[0]).toBe("✅ bash");
    expect(out[1]?.lines[0]).toBe("bash → exit 0");
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

describe("transcriptLogEntries per-turn summaries and tokens", () => {
  it("appends a status entry per finished turn when metrics are known", () => {
    const turns = new Map<number, { usage?: TokenUsage; durationMs?: number }>();
    turns.set(1, {
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      durationMs: 2200,
    });
    turns.set(2, {
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      durationMs: 900,
    });
    const out = transcriptLogEntries(
      toTranscriptEntries([
        row({ seq: 1, role: "user", content: "q1", turnId: "1" }),
        row({ seq: 2, role: "assistant", content: "a1", turnId: "1" }),
        row({ seq: 3, role: "user", content: "q2", turnId: "2" }),
        row({ seq: 4, role: "assistant", content: "a2", turnId: "2" }),
      ]),
      COLS,
      { turns },
    );
    expect(out.map((e) => e.kind)).toEqual([
      "user",
      "assistant",
      "status",
      "user",
      "assistant",
      "status",
    ]);
    expect(out[2]?.lines[0]).toBe("runtime 2s · 0 tool calls · 150 tokens");
    expect(out[5]?.lines[0]).toBe("runtime 900ms · 0 tool calls · 15 tokens");
  });

  it("counts tool calls per hydrated turn in its summary", () => {
    const turns = new Map<number, { usage?: TokenUsage; durationMs?: number }>();
    turns.set(1, { durationMs: 500, usage: { total_tokens: 42 } });
    const out = transcriptLogEntries(
      toTranscriptEntries([
        row({ seq: 1, role: "user", content: "run", turnId: "1" }),
        row({
          seq: 2,
          role: "assistant",
          toolCalls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
          turnId: "1",
        }),
        row({
          seq: 3,
          role: "tool",
          toolCallId: "c1",
          name: "bash",
          content: '{"exitCode":0}',
          turnId: "1",
        }),
        row({ seq: 4, role: "user", content: "next", turnId: "2" }),
      ]),
      COLS,
      { turns },
    );
    const status = out.find((e) => e.kind === "status");
    expect(status?.lines[0]).toBe("runtime 500ms · 1 tool call · 42 tokens");
  });

  it("rehydrated chunk headers stay execution facts (no token segments)", () => {
    const out = transcriptLogEntries(
      toTranscriptEntries([
        row({
          seq: 1,
          role: "assistant",
          toolCalls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
        }),
        row({
          seq: 2,
          role: "tool",
          toolCallId: "c1",
          name: "bash",
          content: '{"exitCode":0,"stdout":"hi"}',
        }),
      ]),
      COLS,
    );
    const chunk = out.find((e) => e.kind === "chunk");
    expect(chunk?.lines[0]).toBe("bash → exit 0");
  });

  it("omits per-turn status entries when no metrics are provided", () => {
    const out = transcriptLogEntries(
      toTranscriptEntries([
        row({ seq: 1, role: "user", content: "q", turnId: "1" }),
        row({ seq: 2, role: "assistant", content: "a", turnId: "1" }),
      ]),
      COLS,
    );
    expect(out.map((e) => e.kind)).toEqual(["user", "assistant"]);
  });

  it("rides each rehydrated result row's usage onto ITS OWN result block", () => {
    const turns = new Map<number, { usage?: TokenUsage; durationMs?: number }>();
    turns.set(1, { durationMs: 500, usage: { total_tokens: 42 } });
    const out = transcriptLogEntries(
      toTranscriptEntries([
        row({
          seq: 1,
          role: "assistant",
          toolCalls: [
            { id: "c1", type: "function", function: { name: "bash", arguments: "{}" } },
            { id: "c2", type: "function", function: { name: "bash", arguments: "{}" } },
          ],
          promptDelta: 120,
          turnId: "1",
        }),
        row({
          seq: 2,
          role: "tool",
          toolCallId: "c1",
          name: "bash",
          content: '{"exitCode":0,"stdout":"one"}',
          promptDelta: 120,
          resultTokens: 1200,
          turnId: "1",
        }),
        row({
          seq: 3,
          role: "tool",
          toolCallId: "c2",
          name: "bash",
          content: '{"exitCode":0,"stdout":"two"}',
          promptDelta: 60,
          resultTokens: 400,
          turnId: "1",
        }),
      ]),
      COLS,
      { turns },
    );
    // The call lines (⚙️ args rows) never carry a count — a figure appended
    // after c1's args would sit directly above c2's call line and read as
    // c2's attribution. Each result chunk carries its row's own count.
    const kinds = out.map((e) => e.kind);
    const firstCall = out.findIndex((e) => e.kind === "tool");
    expect(out[firstCall]?.lines[0]).not.toContain("120");
    expect(out[firstCall]?.tokenNote).toBeUndefined();
    const c1chunk = out[firstCall + 1];
    expect(c1chunk?.kind).toBe("chunk");
    expect(c1chunk?.lines[0]).toBe("bash → exit 0 · ~1.2K tok");
    const c2chunk = out[firstCall + 3];
    expect(c2chunk?.kind).toBe("chunk");
    expect(c2chunk?.lines[0]).toBe("bash → exit 0 · ~400 tok");
    expect(kinds.filter((k) => k === "chunk").length).toBe(2);
  });
});

describe("createTurnPresenter per-call tokens (live)", () => {
  it("rides envelope tokens into the tool-result chunk header", () => {
    const host = {
      entries: [] as LogEntry[],
      append: (kind: LogEntry["kind"], lines: string[]) => {
        host.entries.push({ kind, lines });
      },
      width: () => COLS,
      requestRender: () => {},
    };
    const presenter = createTurnPresenter(host);
    presenter.events.onToolCall?.("c1", "bash", "{}");
    presenter.events.onToolResult?.(
      "c1",
      "bash",
      true,
      { exitCode: 0, stdout: "hi" },
      undefined,
      undefined,
      undefined,
      7,
    );
    const chunk = host.entries.find((e) => e.kind === "chunk");
    // The token count lands on THIS call's own result block: the bash
    // chunk header (issue #70), not the ⚙️ call line — a figure on the args
    // row would read as the NEXT call's attribution.
    expect(chunk?.lines[0]).toBe("bash → exit 0 · ~7 tok");
    const call = host.entries.find((e) => e.kind === "tool");
    expect(call?.lines[0]).not.toContain("7 tok");
    expect(call?.tokenNote).toBeUndefined();
  });
});

describe("createTurnPresenter tool-result token counts (live)", () => {
  it("puts the round count on the single call's own result block (not the call line)", () => {
    const { host, entries } = makeHost();
    const turn = createTurnPresenter(host);
    turn.events.onToolCall?.("c1", "bash", parseToolArgs('{"cmd":"ls"}'));
    turn.events.onToolResult?.(
      "c1",
      "bash",
      true,
      { exitCode: 0, stdout: "out" },
      undefined,
      undefined,
      undefined,
      1200,
    );
    const chunk = entries.find((e) => e.kind === "chunk");
    // The count belongs to THIS call's bash chunk header, as +Nt (context
    // delta) — never appended to the ⚙️ call line after the args.
    expect(chunk?.lines[0]).toBe("bash → exit 0 · ~1.2K tok");
    expect(chunk?.tokenNote).toBe("~1.2K tok");
    const call = entries.find((e) => e.kind === "tool");
    expect(call?.lines[0]).not.toContain("120");
    expect(call?.lines[0]).not.toContain("(batch)");
    expect(call?.tokenNote).toBeUndefined();
  });

  it("attributes each batch member's count to its own result block, never to the next call", () => {
    const { host, entries } = makeHost();
    const turn = createTurnPresenter(host);
    turn.events.onToolCall?.("c1", "bash", parseToolArgs('{"cmd":"ls"}'));
    turn.events.onToolCall?.("c2", "bash", parseToolArgs('{"cmd":"pwd"}'));
    turn.events.onToolResult?.(
      "c1",
      "bash",
      true,
      { exitCode: 0, stdout: "ls out" },
      undefined,
      undefined,
      undefined,
      2400,
    );
    turn.events.onToolResult?.(
      "c2",
      "bash",
      true,
      { exitCode: 0, stdout: "pwd out" },
      undefined,
      undefined,
      undefined,
      40,
    );
    // Each call's OWN chunk carries the count; the c2 chunk sits between
    // the c1 chunk and the c2 call line, so a figure appended to the c1
    // CALL LINE would visually belong to c2 — hence none goes there.
    // Only tool-call rows (⚙️ args lines) go in the index map; chunk
    // headers also mention the tool name, so they must not match.
    const lines = entries.map((e) =>
      e.kind === "tool" && e.lines[0]?.includes("⚙️") ? (e.lines[0] ?? "") : "",
    );
    const lsIdx = lines.findIndex((l) => l.includes("ls"));
    const pwdIdx = lines.findIndex((l) => l.includes("pwd"));
    expect(entries[lsIdx]?.kind).toBe("tool");
    expect(entries[pwdIdx]?.kind).toBe("tool");
    expect(entries[lsIdx + 1]?.kind).toBe("chunk");
    expect(entries[lsIdx + 1]?.lines[0]).toBe("bash → exit 0 · ~2.4K tok");
    expect(entries[lsIdx + 1]?.tokenNote).toBe("~2.4K tok");
    expect(entries[pwdIdx + 1]?.kind).toBe("chunk");
    expect(entries[pwdIdx + 1]?.lines[0]).toBe("bash → exit 0 · ~40 tok");
    expect(entries[pwdIdx + 1]?.tokenNote).toBe("~40 tok");
    // The call lines stay pure args rows — no token figures, no batch tag.
    expect(lines[lsIdx]).not.toContain("2400");
    expect(lines[lsIdx]).not.toContain("(batch)");
    expect(lines[pwdIdx]).not.toContain("40");
    expect(lines[pwdIdx]).not.toContain("(batch)");
    expect(entries[lsIdx]?.tokenNote).toBeUndefined();
    expect(entries[pwdIdx]?.tokenNote).toBeUndefined();
  });

  it("a single-call round after a batch puts the bare count on its own result block", () => {
    const { host, entries } = makeHost();
    const turn = createTurnPresenter(host);
    // Batched round first.
    turn.events.onToolCall?.("c1", "bash", parseToolArgs('{"cmd":"ls"}'));
    turn.events.onToolCall?.("c2", "bash", parseToolArgs('{"cmd":"pwd"}'));
    turn.events.onToolResult?.(
      "c1",
      "bash",
      true,
      { exitCode: 0, stdout: "ls out" },
      undefined,
      undefined,
      undefined,
      2400,
    );
    turn.events.onToolResult?.(
      "c2",
      "bash",
      true,
      { exitCode: 0, stdout: "pwd out" },
      undefined,
      undefined,
      undefined,
      40,
    );
    // Then a plain single-call round.
    turn.events.onToolCall?.("c3", "bash", parseToolArgs('{"cmd":"date"}'));
    turn.events.onToolResult?.(
      "c3",
      "bash",
      true,
      { exitCode: 0, stdout: "date out" },
      undefined,
      undefined,
      undefined,
      30,
    );
    const chunks = entries.filter((e) => e.kind === "chunk");
    expect(chunks.map((c) => c.lines[0])).toEqual([
      "bash → exit 0 · ~2.4K tok",
      "bash → exit 0 · ~40 tok",
      "bash → exit 0 · ~30 tok",
    ]);
    const call3 = entries.find((e) => e.kind === "tool" && (e.lines[0] ?? "").includes("date"));
    expect(call3?.lines[0]).not.toContain("30");
    expect(call3?.lines[0]).not.toContain("(batch)");
  });

  it("uses the per-result estimate when the server sends no round delta", () => {
    const { host, entries } = makeHost();
    const turn = createTurnPresenter(host);
    turn.events.onToolCall?.("c1", "bash", parseToolArgs('{"cmd":"ls"}'));
    turn.events.onToolResult?.(
      "c1",
      "bash",
      true,
      { exitCode: 0, stdout: "ls out" },
      undefined,
      undefined,
      undefined,
      55,
    );
    const chunk = entries.find((e) => e.kind === "chunk");
    // No delta → the round's completion volume, absolute (no plus).
    expect(chunk?.lines[0]).toBe("bash → exit 0 · ~55 tok");
    expect(chunk?.tokenNote).toBe("~55 tok");
    const call = entries.find((e) => e.kind === "tool");
    expect(call?.lines[0]).not.toContain("55");
  });

  it("uses per-result tokenx estimates when the server sends resultTokens", () => {
    const { host, entries } = makeHost();
    const turn = createTurnPresenter(host);
    turn.events.onToolCall?.("c1", "bash", parseToolArgs('{"cmd":"cat"}'));
    turn.events.onToolResult?.(
      "c1",
      "bash",
      true,
      { exitCode: 0, stdout: "big output" },
      undefined,
      undefined,
      undefined,
      1200,
    );
    const chunk = entries.find((e) => e.kind === "chunk");
    expect(chunk?.lines[0]).toBe("bash → exit 0 · ~1.2K tok");
    expect(chunk?.tokenNote).toBe("~1.2K tok");
  });

  it("folds the round's real promptDelta into host.onRoundDelta exactly once per round", () => {
    const deltas: number[] = [];
    const host = {
      entries: [] as LogEntry[],
      append: (kind: LogEntry["kind"], lines: string[]) => {
        host.entries.push({ kind, lines });
      },
      width: () => COLS,
      requestRender: () => {},
      onRoundDelta: (d: number) => deltas.push(d),
    };
    const turn = createTurnPresenter(host);
    turn.events.onToolCall?.("c1", "bash", "{}");
    turn.events.onToolCall?.("c2", "bash", "{}");
    turn.events.onToolResult?.("c1", "bash", true, { exitCode: 0 }, undefined, undefined, 240);
    turn.events.onToolResult?.("c2", "bash", true, { exitCode: 0 }, undefined, undefined, 240);
    expect(deltas).toEqual([240]);
  });
});

describe("createTurnPresenter incremental tokens", () => {
  it("shows the token delta against the session total before the turn ran", () => {
    const host = {
      entries: [] as LogEntry[],
      append: (kind: LogEntry["kind"], lines: string[]) => {
        host.entries.push({ kind, lines });
      },
      width: () => COLS,
      requestRender: () => {},
      prevTokenTotal: () => 150,
    };
    const presenter = createTurnPresenter(host);
    presenter.events.onFinish?.(1000, undefined, {
      prompt_tokens: 80,
      completion_tokens: 120,
      total_tokens: 200,
    });
    const status = host.entries.find((e) => e.kind === "status");
    expect(status?.lines[0]).toBe("runtime 1s · 0 tool calls · 50 tokens");
  });

  it("falls back to the full total when no previous total is provided", () => {
    const host = {
      entries: [] as LogEntry[],
      append: (kind: LogEntry["kind"], lines: string[]) => {
        host.entries.push({ kind, lines });
      },
      width: () => COLS,
      requestRender: () => {},
    };
    const presenter = createTurnPresenter(host);
    presenter.events.onFinish?.(1000, undefined, {
      prompt_tokens: 80,
      completion_tokens: 120,
      total_tokens: 200,
    });
    const status = host.entries.find((e) => e.kind === "status");
    expect(status?.lines[0]).toBe("runtime 1s · 0 tool calls · 200 tokens");
  });
});

describe("transcriptLogEntries — in-flight (synthetic) rows", () => {
  it("renders a running turn's synthetic rows (user, partial prose, tool round) in seq order", () => {
    // The server's transcript dump synthesizes in-flight rows from
    // persisted turn_events while a turn is running; the poll must be
    // able to render them exactly like settled rows.
    const out = transcriptLogEntries(
      toTranscriptEntries([
        row({ seq: 1, turnId: "9", role: "user", content: "inflight q" }),
        row({ seq: 2, turnId: "9", role: "assistant", content: "partial " }),
        row({
          seq: 3,
          turnId: "9",
          role: "assistant",
          toolCalls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
        }),
        row({
          seq: 4,
          turnId: "9",
          role: "tool",
          toolCallId: "c1",
          name: "bash",
          content: '{"exitCode":0,"stdout":"ok"}',
        }),
      ]),
      COLS,
    );
    expect(out.map((e) => e.kind)).toEqual(["user", "assistant", "tool", "chunk"]);
    expect(out[0]?.lines[0]).toBe("inflight q");
    expect(out[1]?.lines[0]).toBe("partial ");
  });
});
