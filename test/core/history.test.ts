import { describe, expect, it } from "vitest";

import { buildPrompt, HISTORY_MESSAGES, type HistoryMessage } from "../../src/core/history.ts";

describe("buildPrompt", () => {
  it("returns the raw input when history is empty", () => {
    expect(buildPrompt([], "hello")).toBe("hello");
  });

  it("labels and joins history with the new input, blank-line separated", () => {
    const history: HistoryMessage[] = [
      { role: "user", text: "q1" },
      { role: "assistant", text: "a1" },
    ];
    expect(buildPrompt(history, "q2")).toBe("User: q1\n\nAssistant: a1\n\nUser: q2");
  });

  it("threads exactly the last HISTORY_MESSAGES (24) messages", () => {
    const history: HistoryMessage[] = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      text: `m${i}`,
    }));
    const prompt = buildPrompt(history, "new");
    const blocks = prompt.split("\n\n");
    // 24 threaded messages + the new input.
    expect(blocks).toHaveLength(HISTORY_MESSAGES + 1);
    expect(blocks[0]).toBe("User: m6"); // m0–m5 trimmed away
    expect(blocks[23]).toBe("Assistant: m29");
    expect(blocks[24]).toBe("User: new");
    expect(prompt).not.toContain("m5");
    expect(prompt).toContain("m6");
  });

  it("trims to the cap without dropping the new input at exactly the cap", () => {
    const history: HistoryMessage[] = Array.from({ length: HISTORY_MESSAGES }, (_, i) => ({
      role: "user",
      text: `m${i}`,
    }));
    const blocks = buildPrompt(history, "new").split("\n\n");
    expect(blocks).toHaveLength(HISTORY_MESSAGES + 1);
    expect(blocks[0]).toBe("User: m0");
    expect(blocks.at(-1)).toBe("User: new");
  });

  it("honors a custom limit", () => {
    const history: HistoryMessage[] = [
      { role: "user", text: "old" },
      { role: "assistant", text: "recent" },
    ];
    expect(buildPrompt(history, "new", 1)).toBe("Assistant: recent\n\nUser: new");
  });
});