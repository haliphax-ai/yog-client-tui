import { afterEach, describe, expect, it } from "vitest";

import {
  sessionStats,
  statusBody,
  StatusComponent,
} from "../../../src/ui/components/StatusComponent.ts";
import { resetForTests, setState } from "../../../src/core/store.ts";
import { displayWidth, stripAnsi } from "../../../src/util/ansi.ts";
import type { LogEntry } from "../../../src/core/entries.ts";

/** Collect one status line body, then restore the default store. */
function body(patch: Parameters<typeof setState>[0]): string {
  setState(patch);
  return statusBody();
}

/** A log with `turns` user messages and `toolCalls` ⚙️ call entries. */
function fixture(turns: number, toolCalls: number): LogEntry[] {
  return [
    ...Array.from({ length: turns }, () => ({ kind: "user" as const, lines: ["hello"] })),
    ...Array.from({ length: toolCalls }, () => ({ kind: "tool" as const, lines: ["⚙️ run"] })),
  ];
}

describe("statusBody", () => {
  afterEach(() => {
    resetForTests();
  });

  it("shows session and stats segments separated by a vertical bar", () => {
    const out = body({ model: "m-1", connection: "connected", entries: fixture(2, 27) });
    expect(out).toBe("👤 m-1 · 🔌 ok │ 🔄 2  🔧 27");
  });

  it("prepends the spinner + generating as its own segment while busy", () => {
    const out = body({ busy: true, busyFrame: 0, model: "m-1", connection: "connected" });
    expect(out).toMatch(/^⠋ generating │ 👤 m-1 · 🔌 ok │ 🔄 0  🔧 0/);
    expect(out).not.toMatch(/·.*⠋|⠋.*·.*generating/);
  });

  it("joins the transient note into the activity segment", () => {
    const out = body({ statusNote: "session saved — bye", model: "m-1", connection: "connected" });
    expect(out).toMatch(/^session saved — bye │ 👤 m-1 · 🔌 ok │/);
  });

  it("reflects a non-connected state in the session segment", () => {
    const out = body({ model: "m-1", connection: "error" });
    expect(out).toMatch(/^👤 m-1 · 🔌 error │/);
  });

  it("counts turns and tool calls from the log entries", () => {
    expect(sessionStats(fixture(2, 27))).toEqual({ turns: 2, toolCalls: 27 });
    expect(sessionStats([])).toEqual({ turns: 0, toolCalls: 0 });
    // assistant/chunk/system entries do not count
    expect(
      sessionStats([
        { kind: "assistant", lines: ["hi"] },
        { kind: "chunk", lines: ["x"], collapsed: true },
        { kind: "system", lines: ["y"] },
      ]),
    ).toEqual({ turns: 0, toolCalls: 0 });
  });

  it("removes the key legend segment", () => {
    const out = body({ busy: true, model: "m-1", connection: "connected" });
    expect(out).not.toContain("Shift+Up/Down focus");
    expect(out).not.toContain("Enter send");
    expect(out).not.toContain("/quit exit");
    expect(out).not.toContain("thinking");
  });
});

describe("StatusComponent render", () => {
  afterEach(() => {
    resetForTests();
  });

  it("renders dark grey backing with black text, padded to the width", () => {
    const line = new StatusComponent().render({ cols: 80 });
    expect(line).toContain("48;2;63;63;70"); // #3f3f46 background
    expect(line).toContain("38;2;0;0;0"); // black text
    expect(displayWidth(stripAnsi(line))).toBe(80);
  });

  it("renders the spinner + generating in bright purple while busy", () => {
    setState({ busy: true, busyFrame: 0, model: "m-1", connection: "connected" });
    const line = new StatusComponent().render({ cols: 80 });
    expect(line).toContain("38;2;192;132;252"); // #c084fc bright purple
    expect(stripAnsi(line)).toContain("⠋ generating");
    expect(line).toContain("38;2;0;0;0"); // default black restored after the span
  });

  it("emoji labels are two cells wide", () => {
    for (const label of ["👤", "🔌", "🔄", "🔧"]) {
      expect(displayWidth(label)).toBe(2);
    }
  });
});
