import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetFrameCache, writeFrame } from "../../../src/ui/pipeline/emit.ts";
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

describe("emit — diff frame writer", () => {
  beforeEach(() => {
    resetFrameCache();
  });

  it("writes every row on the first frame (no baseline yet)", () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    writeFrame("one\ntwo\nthree");
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("\x1b[Hone\r\ntwo\r\nthree");
  });

  it("paints only the changed rows on the next frame", () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    writeFrame("one\ntwo\nthree");
    write.mockClear();
    writeFrame("one\nTWO\nthree");
    // Cursor home + transit to row 2, then the changed row only.
    expect(write).toHaveBeenCalledWith("\x1b[H\r\nTWO");
  });

  it("writes nothing when the frame is identical", () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    writeFrame("one\ntwo");
    write.mockClear();
    writeFrame("one\ntwo");
    expect(write).not.toHaveBeenCalled();
  });

  it("erases below when the frame shrinks", () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    writeFrame("one\ntwo\nthree");
    write.mockClear();
    writeFrame("one\ntwo");
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("\x1b[J");
  });

  it("repaints everything after a reset (resize path)", () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    writeFrame("one\ntwo");
    resetFrameCache();
    write.mockClear();
    writeFrame("one\ntwo");
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("\x1b[Hone\r\ntwo");
  });
});

describe("emit — resize swap without blank (#67)", () => {
  beforeEach(() => {
    resetFrameCache();
  });

  it("repaints as one swap write after reset, never a blank intermediate", () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    writeFrame("old one\nold two");
    resetFrameCache();
    write.mockClear();
    // The host's onResize path: reset + single draw. The emit must be a
    // single HOME-anchored full repaint — no split blank-then-paint.
    writeFrame("new one\nnew two");
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("\x1b[Hnew one\r\nnew two");
    // No clear-screen sequence in the swap.
    expect(String(write.mock.calls[0]?.[0])).not.toContain("\x1b[2J");
  });
});
