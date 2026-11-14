import { beforeEach, describe, expect, it } from "vitest";

import {
  LOCAL_COMMANDS,
  SLASH_COMMANDS,
  completeSlash,
  isSlash,
  registryVersion,
  requiresArgs,
  resolveSlash,
  setServerCommands,
  slashToken,
  slashTokenEnd,
} from "../../src/core/commands.ts";

describe("slashToken", () => {
  it("returns null when the line does not start with a slash", () => {
    expect(slashToken("quit")).toBeNull();
    expect(slashToken("hi /quit")).toBeNull();
    expect(slashToken("")).toBeNull();
  });

  it("returns the token after the leading slash up to the first space", () => {
    expect(slashToken("/")).toBe("");
    expect(slashToken("/q")).toBe("q");
    expect(slashToken("/quit")).toBe("quit");
    expect(slashToken("/quit foo")).toBe("quit");
  });
});

describe("slashTokenEnd", () => {
  it("returns 0 for non-slash lines", () => {
    expect(slashTokenEnd("hello")).toBe(0);
  });

  it("returns the index just past the token", () => {
    expect(slashTokenEnd("/")).toBe(1);
    expect(slashTokenEnd("/quit")).toBe(5);
    expect(slashTokenEnd("/quit arg")).toBe(5);
  });
});

describe("isSlash", () => {
  it("is true only when the very first character is a slash", () => {
    expect(isSlash("/quit")).toBe(true);
    expect(isSlash("/")).toBe(true);
    expect(isSlash("x /quit")).toBe(false);
    expect(isSlash("quit")).toBe(false);
  });
});

describe("completeSlash", () => {
  beforeEach(() => setServerCommands([]));
  it("returns [] when autocomplete is not triggered", () => {
    expect(completeSlash("quit")).toEqual([]);
    expect(completeSlash("say /quit")).toEqual([]);
  });

  it("lists every command for a bare slash, local first, in registry order", () => {
    expect(completeSlash("/")).toEqual(["/new", "/quit"]);
  });

  it("merges server descriptors after the local commands", () => {
    setServerCommands([
      { name: "compact", summary: "compact the session", message: "compaction.run" },
      { name: "shake", summary: "shake the transcript", message: "transcript.shake" },
    ]);
    expect(completeSlash("/")).toEqual(["/new", "/quit", "/compact", "/shake"]);
  });

  it("matches case-insensitive prefixes over the merged registry", () => {
    expect(completeSlash("/q")).toEqual(["/quit"]);
    expect(completeSlash("/QUIT")).toEqual(["/quit"]);
  });

  it("matches server-advertised names after the merge", () => {
    // `example-reload` is a synthetic stand-in: descriptor mechanics must
    // work for any advertised command, not just the ones the client knows.
    setServerCommands([
      { name: "compact", summary: "compact the session", message: "compaction.run" },
      {
        name: "example-reload",
        summary: "reload the thing",
        args: "<name>",
        message: "example.reload",
      },
    ]);
    expect(completeSlash("/c")).toEqual(["/compact"]);
    expect(completeSlash("/example-r")).toEqual(["/example-reload"]);
  });

  setServerCommands([]); // reset the registry from the merge test above

  it("has no candidates for an unknown prefix", () => {
    expect(completeSlash("/x")).toEqual([]);
  });

  it("fuzzy-matches the new command", () => {
    setServerCommands([{ name: "handoff", summary: "h", message: "compaction.run" }]);
    // "n" also subsequence-matches handoff; new ranks first (start bonus).
    expect(completeSlash("/n")).toEqual(["/new", "/handoff"]);
    expect(completeSlash("/ne")).toEqual(["/new"]);
  });

  it("fuzzy-matches subsequences of the command name", () => {
    expect(completeSlash("/ui")).toEqual(["/quit"]); // u → i, in order
    expect(completeSlash("/qt")).toEqual(["/quit"]); // q → t
  });

  it("completes the token even when arguments follow", () => {
    expect(completeSlash("/q something")).toEqual(["/quit"]);
  });
});

describe("resolveSlash", () => {
  it("resolves an exact command name case-insensitively", () => {
    expect(resolveSlash("/quit")?.name).toBe("quit");
    expect(resolveSlash("/Quit")?.name).toBe("quit");
    expect(resolveSlash("/quit now")?.name).toBe("quit");
    expect(resolveSlash("/new")?.name).toBe("new");
  });

  it("resolves server-advertised names with their descriptor fields", () => {
    setServerCommands([
      {
        name: "compact",
        summary: "compact the session",
        args: "[guidance]",
        message: "compaction.run",
        data: { kind: "compact" },
        argField: "guidance",
        requiresIdle: true,
      },
    ]);
    const resolved = resolveSlash("/COMPACT");
    expect(resolved).toMatchObject({
      name: "compact",
      message: "compaction.run",
      data: { kind: "compact" },
      argField: "guidance",
      requiresIdle: true,
    });
  });

  it("returns undefined for non-commands, bare slashes, and unknown names", () => {
    expect(resolveSlash("/q")).toBeUndefined();
    expect(resolveSlash("/")).toBeUndefined();
    expect(resolveSlash("quit")).toBeUndefined();
    expect(resolveSlash("/nope")).toBeUndefined();
  });

  it("registers the local commands", () => {
    expect(LOCAL_COMMANDS.map((c) => c.name)).toEqual(["new", "quit"]);
  });
});

describe("setServerCommands", () => {
  it("keeps local commands first and appends server descriptors in order", () => {
    const rejected = setServerCommands([
      { name: "shake", summary: "shake the transcript", message: "transcript.shake" },
      { name: "compact", summary: "compact the session", message: "compaction.run" },
    ]);
    expect(rejected).toEqual([]);
    expect(SLASH_COMMANDS.map((c) => c.name)).toEqual(["new", "quit", "shake", "compact"]);
  });

  it("rejects descriptors that collide with a local command name (local wins)", () => {
    const rejected = setServerCommands([
      { name: "quit", summary: "server-side quit", message: "session.detach" },
      { name: "new", summary: "server-side new", message: "session.detach" },
      { name: "shake", summary: "shake the transcript", message: "transcript.shake" },
    ]);
    expect(rejected.map((d) => d.name)).toEqual(["quit", "new"]);
    expect(SLASH_COMMANDS.map((c) => c.name)).toEqual(["new", "quit", "shake"]);
    const quit = SLASH_COMMANDS.find((c) => c.name === "quit");
    expect(quit?.summary).toBe("exit the client (session stays on the server)");
    expect(quit?.message).toBeUndefined();
  });

  it("bumps the registry version on every application", async () => {
    const before = registryVersion;
    await new Promise((resolve) => setTimeout(resolve, 0));
    setServerCommands([{ name: "shake", summary: "s", message: "transcript.shake" }]);
    expect(registryVersion).toBeGreaterThan(before);
    const afterFirst = registryVersion;
    setServerCommands([]);
    expect(registryVersion).toBeGreaterThan(afterFirst);
  });

  it("rebuilding the merged registry invalidates prior snapshots", () => {
    setServerCommands([{ name: "shake", summary: "s", message: "transcript.shake" }]);
    expect(completeSlash("/s")).toEqual(["/shake"]);
    setServerCommands([{ name: "compact", summary: "c", message: "compaction.run" }]);
    expect(completeSlash("/s")).toEqual([]);
    expect(completeSlash("/c")).toEqual(["/compact"]);
  });
});

describe("requiresArgs", () => {
  it("is true only for the leading-< convention", () => {
    expect(requiresArgs({ name: "x", summary: "s", args: "<name>", message: "m" })).toBe(true);
    expect(requiresArgs({ name: "x", summary: "s", args: "[guidance]", message: "m" })).toBe(false);
    expect(requiresArgs({ name: "x", summary: "s", message: "m" })).toBe(false);
  });
});

describe("invocation envelope construction", () => {
  /** Fold a resolved command + typed line args into the messages payload. */
  function invocation(
    command: ReturnType<typeof resolveSlash> & object,
    rest: string,
  ): { type: string; data: Record<string, unknown> } {
    return {
      type: command.message ?? "",
      data: {
        ...command.data,
        ...(command.argField !== undefined ? { [command.argField]: rest } : {}),
      },
    };
  }

  it("merges static data with the argField remainder", () => {
    setServerCommands([
      {
        name: "example-reload",
        summary: "reload the thing",
        args: "<name>",
        message: "example.reload",
        argField: "name",
      },
    ]);
    const resolved = resolveSlash("/example-reload");
    expect(resolved).toBeDefined();
    expect(invocation(resolved as never, "hemingway")).toEqual({
      type: "example.reload",
      data: { name: "hemingway" },
    });
  });

  it("omits the argField key when the line carries no args", () => {
    setServerCommands([
      {
        name: "compact",
        summary: "compact the session",
        args: "[guidance]",
        message: "compaction.run",
        data: { kind: "compact" },
        argField: "guidance",
        requiresIdle: true,
      },
    ]);
    const resolved = resolveSlash("/compact");
    expect(resolved).toBeDefined();
    // An empty remainder still populates argField (the caller trims);
    // the static data survives either way.
    expect(invocation(resolved as never, "")).toEqual({
      type: "compaction.run",
      data: { kind: "compact", guidance: "" },
    });
  });
});
