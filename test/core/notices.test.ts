import { describe, expect, it } from "vitest";

import { noticeLine } from "../../src/core/notices.ts";

describe("noticeLine", () => {
  it("formats the shared shape: emoji, event, dot separator, detail", () => {
    expect(noticeLine("notice", "turn aborted", "by operator")).toEqual([
      "⏹️ turn aborted",
      "by operator",
    ]);
  });

  it("keeps event-specific emoji for known events", () => {
    expect(noticeLine("notice", "shake", "3 arg(s) truncated")[0]).toBe("🧹 shake");
    expect(noticeLine("notice", "compact", "fresh transcript started")[0]).toBe("📦 compact");
    expect(noticeLine("notice", "handoff", "fresh transcript started")[0]).toBe("🤝 handoff");
    expect(noticeLine("notice", "turn stopped", "reached the tool-round cap")[0]).toBe(
      "⏹️ turn stopped",
    );
  });

  it("keeps the 🪧 tone for client lifecycle events", () => {
    expect(noticeLine("notice", "connected", "detail")[0]).toBe("🪧 connected");
    expect(noticeLine("notice", "model", "detail")[0]).toBe("🪧 model");
    expect(noticeLine("notice", "new session", "detail")[0]).toBe("🪧 new session");
    expect(noticeLine("notice", "session reset", "detail")[0]).toBe("🪧 session reset");
    expect(noticeLine("notice", "session resumed", "detail")[0]).toBe("🪧 session resumed");
    expect(noticeLine("notice", "recovered", "detail")[0]).toBe("🪧 recovered");
  });

  it("falls back to the kind emoji for unknown events", () => {
    expect(noticeLine("notice", "something new", "detail")[0]).toBe("ℹ️ something new");
    expect(noticeLine("error", "something failed", "detail")[0]).toBe("❌ something failed");
  });

  it("drops the dot separator for an empty/whitespace detail", () => {
    expect(noticeLine("notice", "turn aborted", "")).toEqual(["⏹️ turn aborted"]);
    expect(noticeLine("notice", "turn aborted", "   ")).toEqual(["⏹️ turn aborted"]);
  });
});
