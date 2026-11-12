import { describe, expect, it } from "vitest";
import { rehydrateGroups } from "../../src/core/turnPresenter.ts";
import type { TranscriptEntry } from "../../src/core/transcript.ts";

const row = (seq: number, role: "user" | "assistant", text: string): TranscriptEntry =>
  ({ raw: { seq, role }, role, text }) as unknown as TranscriptEntry;

describe("rehydrateGroups stamps the whole-message copy (#109)", () => {
  it("a single assistant prose row carries its whole text", () => {
    const [group] = rehydrateGroups([row(2031, "assistant", "reply with a table")], 80);
    const entry = group?.[0];
    expect(entry?.copyIds?.wholeMessage).toBe("reply with a table");
    expect(entry?.copyIds?.itemId).toBe("2031");
  });

  it("a multi-row run stamps the joined text on the last row", () => {
    const groups = rehydrateGroups(
      [row(1, "assistant", "part one"), row(2, "assistant", "part two")],
      80,
    );
    const flat = groups.flat();
    // The run collapses into ONE entry (the first row) carrying the whole
    // text — matching how a live multi-chunk message focuses.
    expect(flat).toHaveLength(1);
    expect(flat[0]?.lines).toEqual(["part one"]);
    expect(flat[0]?.copyIds?.wholeMessage).toBe("part one\n\npart two");
  });
});
