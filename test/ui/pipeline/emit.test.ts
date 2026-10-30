import { afterEach, describe, expect, it, vi } from "vitest";

import { writeFrame } from "../../../src/ui/pipeline/emit.ts";
import { padFrame, padLine } from "../../../src/ui/pipeline/lines.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("padFrame", () => {
  it("pads every line to the width", () => {
    expect(padFrame("ab\ncd", 4)).toBe("ab  \ncd  ");
  });

  it("truncates overlong lines", () => {
    expect(padFrame("abcdef", 3)).toBe("abc");
  });

  it("leaves exact-width lines untouched", () => {
    const line = "\x1b[31mab\x1b[0m"; // width 2
    expect(padLine(line, 2)).toBe(line);
  });
});

describe("emit — single frame writer", () => {
  it("writes cursor-home + \\r\\n-joined lines to stdout", () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    writeFrame("one\ntwo\nthree");
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("\x1b[Hone\r\ntwo\r\nthree");
  });
});
