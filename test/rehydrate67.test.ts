import { describe, expect, it } from "vitest";
import {
  placeholderForTranscriptEntry,
  placeholderLogEntries,
  rehydrateGroupIndices,
  rehydrateGroups,
  transcriptLogEntries,
} from "../src/core/turnPresenter.ts";
import { toTranscriptEntries } from "../src/core/transcript.ts";
import type { TranscriptMessage } from "../src/yogClient.ts";
import { cachedRows, heightSummaryAnchored, totalRows } from "../src/ui/render/index.ts";
import { stripAnsi, displayWidth } from "../src/util/ansi.ts";
import { ChatLogComponent } from "../src/ui/components/ChatLogComponent.ts";
import type { LogEntry } from "../src/core/entries.ts";

function row(o: Partial<TranscriptMessage>): TranscriptMessage {
  return { seq: 1, role: "user", content: "hello", ...o } as TranscriptMessage;
}
class Log extends ChatLogComponent {
  setOffset(n: number): void {
    this.scrollOffset = n;
  }
  setFollow(v: boolean): void {
    this.follow = v;
  }
  offset(): number {
    return this.scrollOffset;
  }
}

describe("placeholder-first rehydrate (#67)", () => {
  it("placeholder shapes: user/agent/tool/result/system, cell-truncated", () => {
    const entries = toTranscriptEntries([
      row({ role: "user", content: "hello ✅ world ".repeat(30) }),
      row({ role: "assistant", content: "answer ".repeat(30) }),
      row({
        role: "assistant",
        toolCalls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
      }),
      row({ role: "tool", name: "bash", content: '{"exitCode":0}' }),
      row({ role: "system", content: "sys ".repeat(30) }),
    ]);
    const ph = placeholderLogEntries(entries, 60);
    expect(ph.map((e) => e.kind)).toEqual([
      "placeholder",
      "placeholder",
      "placeholder",
      "placeholder",
      "placeholder",
    ]);
    expect(ph[0]?.lines[0]).toContain("user:");
    expect(ph[1]?.lines[0]).toContain("agent:");
    expect(ph[2]?.lines[0]).toBe("tool: bash");
    expect(ph[3]?.lines[0]).toBe("result: bash");
    expect(ph[4]?.lines[0]).toContain("system:");
    for (const e of ph) {
      expect(displayWidth(e.lines[0] ?? "")).toBeLessThanOrEqual(60);
    }
    // Emoji regression (AGENTS.md): truncation is cell-based.
    expect(stripAnsi(ph[0]?.lines[0] ?? "")).toContain("✅");
  });

  it("rehydrate groups concatenate to the full converter output (bottom-up safe)", () => {
    const entries = toTranscriptEntries([
      row({ seq: 1, role: "user", content: "q1" }),
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
        content: '{"exitCode":0,"stdout":"hi"}',
      }),
      row({ seq: 4, role: "assistant", content: "a2" }),
      row({ seq: 5, role: "tool", toolCallId: "cx", name: "noop", content: '{"note":"x"}' }),
    ]);
    const full = transcriptLogEntries(entries, 80);
    const groups = rehydrateGroups(entries, 80);
    expect(groups.flat().map((e) => [e.kind, e.lines])).toEqual(full.map((e) => [e.kind, e.lines]));
    expect(rehydrateGroupIndices(entries)).toEqual([[0], [1, 2], [3], [4]]);
    // Bottom-up order: last group first is the visible tail.
    expect(groups[groups.length - 1]?.[0]?.kind).toBe("tool");
  });

  it("bottom-up swap simulation: placeholders replaced from the tail", () => {
    const entries = toTranscriptEntries([
      row({ seq: 1, role: "user", content: "q1" }),
      row({ seq: 2, role: "assistant", content: "a1" }),
      row({ seq: 3, role: "user", content: "q2" }),
    ]);
    const groups = rehydrateGroups(entries, 80);
    const indices = rehydrateGroupIndices(entries);
    const log: LogEntry[] = [
      { kind: "notice", lines: ["banner"] },
      ...placeholderLogEntries(entries, 80),
    ];
    const logPos = entries.map((_, i) => 1 + i);
    // Swap last group first.
    for (let g = groups.length - 1; g >= 0; g--) {
      const covered = indices[g] as number[];
      const first = logPos[covered[0] as number] as number;
      expect(log[first]?.kind).toBe("placeholder");
      log.splice(first, covered.length, ...(groups[g] as LogEntry[]));
    }
    expect(log.map((e) => e.kind)).toEqual(["notice", "user", "assistant", "user"]);
    expect(log.map((e) => e.lines[0])).toEqual(["banner", "q1", "a1", "q2"]);
  });

  it("placeholder renders as one cheap row without glamour", () => {
    const entry: LogEntry = {
      kind: "placeholder",
      placeholderRole: "user",
      lines: ["user: hello ✅ world"],
    };
    const rows = cachedRows(entry, 80);
    expect(rows).toHaveLength(1);
    expect(stripAnsi(rows.join("\n"))).toContain("user: hello ✅ world");
    expect(totalRows([entry], 80)).toBe(2); // row + separator
  });

  it("anchor-outward summary is exact and matches the top-down total", () => {
    const entries: LogEntry[] = [];
    for (let i = 0; i < 40; i++)
      entries.push({ kind: "assistant", lines: [`reply ${i} **bold** text`] });
    const anchored = heightSummaryAnchored(entries, 80, 39);
    expect(anchored.total).toBe(totalRows(entries, 80));
    expect(anchored.partial).toBe(false);
    // Anchor at the tail still yields exact tops for the head.
    const topAnchored = heightSummaryAnchored(entries, 80, 0);
    expect(topAnchored.tops).toEqual(anchored.tops);
  });

  it("anchored window render matches the full-content slice (follow + mid)", () => {
    const entries: LogEntry[] = [];
    for (let i = 0; i < 30; i++)
      entries.push({ kind: "assistant", lines: [`reply ${i} ` + "word ".repeat(20)] });
    const log = new Log(entries);
    log.setViewportRows(10);
    log.setFollow(true);
    const bottom = log.render({ cols: 60 });
    const full = log.produceRows(60);
    expect(bottom).toEqual(full.slice(log.offset(), log.offset() + 10));
    expect(stripAnsi(bottom.join("\n"))).toContain("reply 29");
    log.setFollow(false);
    log.setOffset(30);
    const mid = log.render({ cols: 60 });
    expect(mid).toEqual(full.slice(log.offset(), log.offset() + 10));
  });

  it("placeholder log resize is cheap (no glamour head pass)", () => {
    const entries: LogEntry[] = [];
    for (let i = 0; i < 200; i++) entries.push({ kind: "placeholder", lines: [`user: q${i}`] });
    const log = new Log(entries);
    log.setViewportRows(24);
    const t0 = performance.now();
    log.render({ cols: 80 });
    log.render({ cols: 100 });
    // Placeholder exact heights avoid glamour: resize must stay well
    // under a full glamour pass over 200 prose entries (~hundreds of ms).
    expect(performance.now() - t0).toBeLessThan(100);
  });
});
