import { describe, expect, it } from "vitest";

import {
  SLASH_COMMANDS,
  completeSlash,
  isSlash,
  resolveSlash,
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
  it("returns [] when autocomplete is not triggered", () => {
    expect(completeSlash("quit")).toEqual([]);
    expect(completeSlash("say /quit")).toEqual([]);
  });

  it("lists every command for a bare slash", () => {
    expect(completeSlash("/")).toEqual(["/quit"]);
  });

  it("matches case-insensitive prefixes", () => {
    expect(completeSlash("/q")).toEqual(["/quit"]);
    expect(completeSlash("/QUIT")).toEqual(["/quit"]);
  });

  it("has no candidates for an unknown prefix", () => {
    expect(completeSlash("/x")).toEqual([]);
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
  });

  it("returns undefined for non-commands, bare slashes, and unknown names", () => {
    expect(resolveSlash("/q")).toBeUndefined();
    expect(resolveSlash("/")).toBeUndefined();
    expect(resolveSlash("quit")).toBeUndefined();
    expect(resolveSlash("/nope")).toBeUndefined();
  });

  it("registers the quit command", () => {
    expect(SLASH_COMMANDS[0]?.name).toBe("quit");
  });
});
