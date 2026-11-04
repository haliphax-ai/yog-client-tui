import { describe, expect, it } from "vitest";

import {
  decodeTurnUsage,
  decodeToolCalls,
  decodeToolResult,
  finalContextTotal,
  perTurnDeltas,
  toTranscriptEntries,
  transcriptText,
} from "../../src/core/transcript.ts";
import type { TranscriptMessage, TokenUsage } from "../../src/yogClient.ts";

/** A minimal well-formed row with overrides. */
function row(overrides: Partial<TranscriptMessage>): TranscriptMessage {
  return { seq: 1, role: "user", content: "hello", ...overrides };
}

describe("transcriptText", () => {
  it("returns user and system content verbatim", () => {
    expect(transcriptText(row({ role: "user", content: "hi there" }))).toBe("hi there");
    expect(transcriptText(row({ role: "system", content: "sys prompt" }))).toBe("sys prompt");
  });

  it("returns an empty string when content is missing or not a string", () => {
    expect(transcriptText(row({ content: undefined }))).toBe("");
    expect(transcriptText(row({ content: 42 as unknown as string }))).toBe("");
  });

  it("summarizes an assistant row carrying tool calls", () => {
    const m = row({
      role: "assistant",
      content: undefined,
      toolCalls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
    });
    expect(transcriptText(m)).toBe("tool call: bash");
  });

  it("keeps assistant text next to its tool-call summary", () => {
    const m = row({
      role: "assistant",
      content: "let me look",
      toolCalls: [
        { id: "c1", type: "function", function: { name: "bash", arguments: "{}" } },
        { id: "c2", type: "function", function: { name: "read", arguments: "{}" } },
      ],
    });
    expect(transcriptText(m)).toBe("let me look [tool call: bash, read]");
  });

  it("returns plain assistant text verbatim without tool calls", () => {
    expect(transcriptText(row({ role: "assistant", content: "plain reply" }))).toBe("plain reply");
  });

  it("renders a tool result row as name → pretty JSON", () => {
    const m = row({
      role: "tool",
      name: "bash",
      toolCallId: "c1",
      content: '{"exitCode":0,"stdout":"ok\\n"}',
    });
    expect(transcriptText(m)).toBe('bash → {\n  "exitCode": 0,\n  "stdout": "ok\\n"\n}');
  });

  it("falls back to the toolCallId when a tool row has no name", () => {
    const m = row({ role: "tool", toolCallId: "call_9", content: '{"a":1}' });
    expect(transcriptText(m)).toBe('call_9 → {\n  "a": 1\n}');
  });

  it("uses a generic label for a tool row with neither name nor id", () => {
    const m = row({ role: "tool", content: "plain output" });
    expect(transcriptText(m)).toBe("tool → plain output");
  });

  it("keeps a non-JSON tool result verbatim", () => {
    const m = row({ role: "tool", name: "bash", content: "raw text output" });
    expect(transcriptText(m)).toBe("bash → raw text output");
  });

  it("notes an empty tool result", () => {
    const m = row({ role: "tool", name: "bash", content: "" });
    expect(transcriptText(m)).toBe("bash → (no result)");
  });
});

describe("decodeToolCalls", () => {
  it("decodes OpenAI-shaped calls with string arguments", () => {
    expect(
      decodeToolCalls([
        { id: "c1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } },
      ]),
    ).toEqual([{ id: "c1", name: "bash", arguments: '{"cmd":"ls"}' }]);
  });

  it("returns [] for absent or malformed payloads", () => {
    expect(decodeToolCalls(undefined)).toEqual([]);
    expect(decodeToolCalls(null)).toEqual([]);
    expect(decodeToolCalls("nope")).toEqual([]);
    expect(decodeToolCalls({ id: "x" })).toEqual([]);
    expect(decodeToolCalls([null, 7, "str", { function: { name: "solo" } }])).toEqual([
      { id: "", name: "solo", arguments: "" },
    ]);
  });

  it("skips calls with neither an id nor a name", () => {
    expect(decodeToolCalls([{ id: "", function: { name: "", arguments: "{}" } }])).toEqual([]);
  });
});

describe("decodeToolResult", () => {
  it("parses a JSON result and reports ok by default", () => {
    const decoded = decodeToolResult(row({ role: "tool", content: '{"exitCode":0}' }));
    expect(decoded.ok).toBe(true);
    expect(decoded.value).toEqual({ exitCode: 0 });
    expect(decoded.error).toBeUndefined();
  });

  it("flags an { error }-shaped result as a failure", () => {
    const decoded = decodeToolResult(row({ role: "tool", content: '{"error":"boom"}' }));
    expect(decoded.ok).toBe(false);
    expect(decoded.error).toBe("boom");
  });

  it("passes non-JSON content through as the raw text", () => {
    const decoded = decodeToolResult(row({ role: "tool", content: "plain output" }));
    expect(decoded.ok).toBe(true);
    expect(decoded.value).toBe("plain output");
  });

  it("treats missing content as an empty string", () => {
    const decoded = decodeToolResult(row({ role: "tool", content: undefined }));
    expect(decoded.value).toBe("");
  });
});

describe("toTranscriptEntries", () => {
  it("expands rows into entries in order, one entry per row", () => {
    const entries = toTranscriptEntries([
      row({ seq: 1, role: "user", content: "q" }),
      row({ seq: 2, role: "assistant", content: "a" }),
      row({ seq: 3, role: "system", content: "s" }),
    ]);
    expect(entries.map((e) => [e.role, e.text])).toEqual([
      ["user", "q"],
      ["assistant", "a"],
      ["system", "s"],
    ]);
  });

  it("preserves the raw row verbatim (full fidelity, no copying)", () => {
    const m = row({ seq: 5, role: "user", content: "keep me".repeat(1000) });
    const [entry] = toTranscriptEntries([m]);
    expect(entry?.raw).toBe(m);
    expect(entry?.text).toBe(m.content);
  });

  it("renders tool rows with their payload intact", () => {
    const m = row({ seq: 6, role: "tool", name: "bash", content: '{"exitCode":0}' });
    const [entry] = toTranscriptEntries([m]);
    expect(entry?.role).toBe("tool");
    expect(entry?.raw.toolCallId ?? entry?.raw.name).toBeDefined();
    expect(entry?.text).toContain("exitCode");
  });

  it("normalizes unknown roles to system entries", () => {
    const entries = toTranscriptEntries([row({ role: "mystery" as "user", content: "?" })]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.role).toBe("system");
  });

  it("tolerates malformed rows without throwing", () => {
    const junk = [
      null,
      undefined,
      42,
      "row",
      [],
      { no: "role at all" },
    ] as unknown as TranscriptMessage[];
    expect(toTranscriptEntries(junk)).toEqual([]);
  });

  it("handles an empty transcript", () => {
    expect(toTranscriptEntries([])).toEqual([]);
  });
});

describe("decodeTurnUsage", () => {
  it("normalizes numeric fields and drops malformed ones", () => {
    expect(decodeTurnUsage({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 })).toEqual({
      prompt_tokens: 1,
      completion_tokens: 2,
      total_tokens: 3,
    });
    expect(decodeTurnUsage({ prompt_tokens: "NaN", completion_tokens: 2 })).toEqual({
      completion_tokens: 2,
    });
  });

  it("returns undefined for absent, null, non-object, or empty payloads", () => {
    expect(decodeTurnUsage(undefined)).toBeUndefined();
    expect(decodeTurnUsage(null)).toBeUndefined();
    expect(decodeTurnUsage([])).toBeUndefined();
    expect(decodeTurnUsage({})).toBeUndefined();
    expect(decodeTurnUsage({ prompt_tokens: "NaN" })).toBeUndefined();
  });
});

describe("finalContextTotal", () => {
  it("returns the last known absolute total (the current context size)", () => {
    expect(
      finalContextTotal([
        { usage: { total_tokens: 150 } },
        { usage: { total_tokens: 250 } },
        undefined,
      ]),
    ).toBe(250);
  });

  it("ignores missing, malformed, and non-positive totals", () => {
    expect(finalContextTotal([{ usage: {} }, { usage: { total_tokens: -5 } }, {}])).toBe(0);
    expect(finalContextTotal(undefined)).toBe(0);
    expect(
      finalContextTotal([
        { usage: { total_tokens: 200 } },
        { usage: { total_tokens: "nope" as unknown as number } },
      ]),
    ).toBe(200);
  });
});

describe("perTurnDeltas", () => {
  it("turns absolute context totals into per-turn deltas (baseline 0)", () => {
    const map = perTurnDeltas([
      { turnId: 1, usage: { total_tokens: 150 }, durationMs: 1000 },
      { turnId: 2, usage: { total_tokens: 200 }, durationMs: 1000 },
      { turnId: 3, usage: { total_tokens: 260 }, durationMs: 1000 },
    ]);
    expect([...map.entries()]).toEqual([
      [1, { usage: { total_tokens: 150 }, durationMs: 1000 }],
      [2, { usage: { total_tokens: 50 }, durationMs: 1000 }],
      [3, { usage: { total_tokens: 60 }, durationMs: 1000 }],
    ]);
  });

  it("skips absent totals without breaking later deltas", () => {
    const map = perTurnDeltas([
      { turnId: 1, usage: { total_tokens: 150 }, durationMs: 1000 },
      { turnId: 2, durationMs: 900 },
      { turnId: 3, usage: { total_tokens: 260 }, durationMs: 1000 },
    ]);
    expect(map.get(1)).toEqual({ usage: { total_tokens: 150 }, durationMs: 1000 });
    expect(map.get(2)).toEqual({ durationMs: 900 });
    // 260 - 150: the middle turn (no usage) is folded into the next delta.
    expect(map.get(3)).toEqual({ usage: { total_tokens: 110 }, durationMs: 1000 });
  });

  it("omits usage when the delta would be negative (provider inconsistency)", () => {
    const map = perTurnDeltas([
      { turnId: 1, usage: { total_tokens: 150 }, durationMs: 1000 },
      { turnId: 2, usage: { total_tokens: 120 }, durationMs: 1000 },
    ]);
    expect(map.get(2)).toEqual({ durationMs: 1000 });
    expect(map.get(2)?.usage).toBeUndefined();
  });

  it("returns an empty map for absent or malformed input", () => {
    expect(perTurnDeltas(undefined)).toEqual(new Map());
    expect(perTurnDeltas([])).toEqual(new Map());
    expect(
      perTurnDeltas([null, 42, { turnId: "x", usage: { total_tokens: 5 } }] as unknown as Array<{
        turnId: number;
        usage?: TokenUsage;
        durationMs?: number;
      }>),
    ).toEqual(new Map());
  });
});
