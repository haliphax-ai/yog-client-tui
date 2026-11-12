import { beforeEach, describe, expect, it } from "vitest";
import { resetForTests, setState } from "../../src/core/store.ts";
import { proseCopyRequest } from "../../src/core/copyText.ts";
import type { LogEntry } from "../../src/core/entries.ts";

describe("Shift+C on any prose chunk of a multi-chunk message (#109)", () => {
  beforeEach(() => resetForTests());

  it("resolves the whole message from the run's stamped tail", () => {
    const first: LogEntry = { kind: "assistant", lines: ["first chunk"], copyIds: { itemId: "7" } };
    const last: LogEntry = {
      kind: "assistant",
      lines: ["second chunk"],
      copyIds: { itemId: "7", wholeMessage: "first chunk\n\nsecond chunk" },
    };
    setState({ entries: [first, last] });
    const request = proseCopyRequest(first, "sess-9", true);
    expect(request?.content).toBe("first chunk\n\nsecond chunk");
    expect(request?.itemId).toBe("sess-9_7");
  });

  it("returns null when no chunk of the run carries a stamp", () => {
    const only: LogEntry = { kind: "assistant", lines: ["bare"], copyIds: { itemId: "9" } };
    setState({ entries: [only] });
    expect(proseCopyRequest(only, "sess-9", true)).toBeNull();
  });
});
