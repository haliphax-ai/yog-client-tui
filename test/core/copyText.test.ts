import { describe, expect, it } from "vitest";

import {
  copyItemId,
  copyProvidersFor,
  entryCopyText,
  proseCopyRequest,
  toolCopyRequest,
  universalJsonCopy,
  wholeMessageCopyText,
} from "../../src/core/copyText.ts";
import type { LogEntry } from "../../src/core/entries.ts";

describe("bash copy providers (#109)", () => {
  it("args provider copies the command value only", () => {
    const provider = copyProvidersFor("bash")?.args;
    expect(provider).toBeDefined();
    // The issue example: {"command": "echo -e \"how are you\""}
    expect(provider?.('{"command":"echo -e \\"how are you\\""}')).toBe('echo -e "how are you"');
    // Parsed-object payloads work too (the live path passes the raw string,
    // but rehydration may hand a parsed object).
    expect(provider?.({ command: "ls -la" })).toBe("ls -la");
  });

  it("args provider declines non-command shapes (universal fallback)", () => {
    const provider = copyProvidersFor("bash")?.args;
    expect(provider?.({ cmd: "ls" })).toBeNull();
    expect(provider?.("{}")).toBeNull();
    expect(provider?.("not json")).toBeNull();
  });

  it("results provider copies the runtime front-matter + stdout sections", () => {
    const provider = copyProvidersFor("bash")?.results;
    expect(provider).toBeDefined();
    // The issue example.
    expect(provider?.({ stdout: "hello\nthere\nhow\nare\nyou?", stderr: null, runtime: 120 })).toBe(
      "---\nruntime: 120ms\n---\n\n## stdout\n\nhello\nthere\nhow\nare\nyou?\n",
    );
  });

  it("results provider includes stderr sections when present", () => {
    const provider = copyProvidersFor("bash")?.results;
    expect(provider?.({ stdout: "out", stderr: "boom", exitCode: 1, runtimeMs: 5 })).toBe(
      "---\nruntime: 5ms\nexit code: 1\n---\n\n## stdout\n\nout\n\n## stderr\n\nboom\n",
    );
  });

  it("results provider declines payloads without execution facts", () => {
    const provider = copyProvidersFor("bash")?.results;
    expect(provider?.({ stdout: "just text" })).toBeNull();
  });
});

describe("universal tool copy", () => {
  it("copies the entire JSON blob (args and result together) as the fallback", () => {
    const entry: LogEntry = {
      kind: "tool",
      lines: ["⚙️ noop"],
      label: "⚙️ noop",
      argsRaw: '{"x":1}',
      result: { ok: true },
    };
    expect(universalJsonCopy(entry)).toBe(
      '{\n  "args": {\n    "x": 1\n  },\n  "result": {\n    "ok": true\n  }\n}',
    );
  });

  it("keeps a non-string result verbatim and a missing one null", () => {
    const entry: LogEntry = { kind: "chunk", lines: ["x →"], result: { a: [1, 2] } };
    expect(universalJsonCopy(entry)).toBe(
      '{\n  "result": {\n    "a": [\n      1,\n      2\n    ]\n  }\n}',
    );
    expect(universalJsonCopy({ kind: "tool", lines: [] } as LogEntry)).toBe(
      '{\n  "result": null\n}',
    );
  });
});

describe("toolCopyRequest (#109)", () => {
  const sessionId = "s-123";

  it("C on a bash call copies the command value (provider, not the blob)", () => {
    const entry: LogEntry = {
      kind: "tool",
      lines: ["⚙️ bash ✅"],
      label: "⚙️ bash ✅",
      argsRaw: '{"command":"echo hi"}',
      copyIds: { itemId: "c1" },
    };
    const request = toolCopyRequest(entry, sessionId, false);
    expect(request?.content).toBe("echo hi");
    expect(request?.itemId).toBe("s-123_c1");
    expect(request?.provided).toBe(true);
  });

  it("C on a bash result chunk copies the markdown results blob", () => {
    const entry: LogEntry = {
      kind: "chunk",
      lines: ["bash → exit 0 · 42ms"],
      collapsed: true,
      result: { stdout: "hello\nthere", stderr: null, runtime: 120 },
      copyIds: { itemId: "c1" },
    };
    const request = toolCopyRequest(entry, sessionId, false);
    expect(request?.content).toBe("---\nruntime: 120ms\n---\n\n## stdout\n\nhello\nthere\n");
  });

  it("Shift+C on a tool entry copies the entire JSON blob (whole item)", () => {
    const entry: LogEntry = {
      kind: "tool",
      lines: ["⚙️ bash ✅"],
      label: "⚙️ bash ✅",
      argsRaw: '{"command":"echo hi"}',
      copyIds: { itemId: "c1" },
    };
    const request = toolCopyRequest(entry, sessionId, true);
    expect(request?.content).toBe(
      '{\n  "args": {\n    "command": "echo hi"\n  },\n  "result": null\n}',
    );
  });

  it("falls back to the whole JSON blob for tools without a provider", () => {
    const entry: LogEntry = {
      kind: "tool",
      lines: ["⚙️ read ✅"],
      label: "⚙️ read ✅",
      argsRaw: '{"path":"/tmp/x"}',
      copyIds: { itemId: "c2" },
    };
    const request = toolCopyRequest(entry, undefined, false);
    expect(request?.content).toContain('"args"');
    expect(request?.content).toContain('"path"');
    // No session id: the bare item id (the sink resolves the session).
    expect(request?.itemId).toBe("c2");
    expect(request?.provided).toBe(false);
  });

  it("returns null for an entry with no copy identity", () => {
    const entry: LogEntry = { kind: "tool", lines: ["⚙️ bash"] };
    expect(toolCopyRequest(entry, sessionId, false)).toBeNull();
  });

  it("exposes the item id for toasts (the sink builds the filename)", () => {
    const entry: LogEntry = {
      kind: "tool",
      lines: ["⚙️ bash"],
      copyIds: { itemId: "c9", sessionId: "s-1" },
    };
    expect(copyItemId(entry)).toBe("c9");
  });
});

describe("proseCopyRequest (#109)", () => {
  const sessionId = "s-123";

  it("C copies the raw Markdown snapshot", () => {
    const entry: LogEntry = {
      kind: "assistant",
      lines: ["Hello **world**"],
      copyText: "Hello **world**",
      copyIds: { itemId: "17" },
    };
    const request = proseCopyRequest(entry, sessionId, false);
    expect(request?.content).toBe("Hello **world**");
    expect(request?.itemId).toBe("s-123_17");
  });

  it("Shift+C copies the whole message stamped on the last chunk", () => {
    const entry: LogEntry = {
      kind: "assistant",
      lines: ["second chunk"],
      copyText: "second chunk",
      copyIds: { itemId: "18", wholeMessage: "first chunk\n\nsecond chunk" },
    };
    const request = proseCopyRequest(entry, sessionId, true);
    expect(request?.content).toBe("first chunk\n\nsecond chunk");
  });

  it("Shift+C on a user entry copies the prompt itself", () => {
    const entry: LogEntry = {
      kind: "user",
      lines: ["fix the bug"],
      copyText: "fix the bug",
      copyIds: { itemId: "5" },
    };
    expect(proseCopyRequest(entry, sessionId, true)?.content).toBe("fix the bug");
  });

  it("declines entries without copy identity or whole-message text", () => {
    expect(proseCopyRequest({ kind: "assistant", lines: ["x"] }, sessionId, false)).toBeNull();
    expect(
      proseCopyRequest(
        { kind: "assistant", lines: ["x"], copyIds: { itemId: "1" } } as LogEntry,
        sessionId,
        true,
      ),
    ).toBeNull();
  });

  it("falls back to the logical lines when no snapshot was stamped", () => {
    const entry: LogEntry = { kind: "user", lines: ["a", "b"], copyIds: { itemId: "7" } };
    expect(entryCopyText(entry)).toBe("a\nb");
    expect(proseCopyRequest(entry, undefined, false)?.content).toBe("a\nb");
  });

  it("wholeMessageCopyText mirrors the prose rules", () => {
    expect(
      wholeMessageCopyText({
        kind: "assistant",
        lines: [],
        copyIds: { itemId: "1", wholeMessage: "w" },
      } as LogEntry),
    ).toBe("w");
    expect(wholeMessageCopyText({ kind: "user", lines: ["p"] } as LogEntry)).toBe("p");
    expect(wholeMessageCopyText({ kind: "tool", lines: [] } as LogEntry)).toBeNull();
  });
});
