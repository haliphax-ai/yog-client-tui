import { describe, expect, it } from "vitest";

import { noticeLine } from "../../src/core/notices.ts";

describe("noticeLine", () => {
  it("formats the shared shape: emoji, event, dot separator, detail", () => {
    expect(noticeLine("notice", "turn aborted", "by operator")).toEqual([
      "⏹️ turn aborted",
      "by operator",
    ]);
  });

  it("keeps event-specific emoji for known events (all kinds)", () => {
    expect(noticeLine("notice", "shake", "3 arg(s) truncated")[0]).toBe("🧹 shake");
    expect(noticeLine("notice", "compact", "fresh transcript started")[0]).toBe("📦 compact");
    expect(noticeLine("notice", "handoff", "fresh transcript started")[0]).toBe("🤝 handoff");
    expect(noticeLine("notice", "turn stopped", "reached the tool-round cap")[0]).toBe(
      "⏹️ turn stopped",
    );
    expect(noticeLine("system", "turn aborted", "detail")[0]).toBe("⏹️ turn aborted");
  });

  it("falls back to the kind emoji for unknown events", () => {
    expect(noticeLine("notice", "something new", "detail")[0]).toBe("ℹ️ something new");
    expect(noticeLine("error", "something failed", "detail")[0]).toBe("❌ something failed");
    expect(noticeLine("system", "something happened", "detail")[0]).toBe("🪧 something happened");
  });

  it("drops the dot separator for an empty/whitespace detail", () => {
    expect(noticeLine("notice", "turn aborted", "")).toEqual(["⏹️ turn aborted"]);
    expect(noticeLine("notice", "turn aborted", "   ")).toEqual(["⏹️ turn aborted"]);
  });
});
