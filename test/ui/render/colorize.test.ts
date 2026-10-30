import { describe, expect, it } from "vitest";

import { colorizeToolLine } from "../../../src/ui/render/colorize.ts";
import { C } from "../../../src/ui/theme.ts";
import { stripAnsi } from "../../../src/util/ansi.ts";

describe("colorizeToolLine: escaped quotes", () => {
  it("keeps an escaped quote inside a string (it does not close it)", () => {
    expect(colorizeToolLine('{"a":"say \\"hi\\" now"}')).toBe(
      "\x1b[38;5;245m{\x1b[39m" +
        '\x1b[38;5;39m"a"\x1b[39m' +
        "\x1b[38;5;245m:\x1b[39m" +
        '\x1b[38;5;114m"say \\"hi\\" now"\x1b[39m' +
        "\x1b[38;5;245m}\x1b[39m",
    );
  });

  it("does not open a string at an escaped quote after a wrap split", () => {
    // Row 1 ends inside "value (open string carried); row 2 starts with \"
    // — the escape must pass through as string content, not open a new
    // key-colored token.
    const out = colorizeToolLine('{"a":"value\n\\" tail"}');
    const [, second] = out.split("\n");
    // No key-colored token on the continuation row; the closing quote is
    // string-colored; stripping recovers the input.
    expect(second).not.toContain(C.key);
    expect(second).toContain(`${C.str}"${C.reset}`);
    expect(stripAnsi(out)).toBe('{"a":"value\n\\" tail"}');
  });

  it("keeps the string color when a backslash sits against the wrap split", () => {
    // The wrap falls between the \ and the " it escapes: the continuation
    // row starts inside an escape, mid-string, and keeps string color.
    const out = colorizeToolLine('{"a":"v\\\n\\" tail"}');
    const [, second] = out.split("\n");
    expect(second).not.toContain(C.key);
    expect(second).toContain(`${C.str}"${C.reset}`);
    expect(stripAnsi(out)).toBe('{"a":"v\\\n\\" tail"}');
  });

  it("colors a string that ends with an escaped backslash, then closes", () => {
    // {"p":"a\\"} — the \\ is content, the final " closes the string.
    expect(colorizeToolLine('{"p":"a\\\\"}')).toBe(
      "\x1b[38;5;245m{\x1b[39m" +
        '\x1b[38;5;39m"p"\x1b[39m' +
        "\x1b[38;5;245m:\x1b[39m" +
        '\x1b[38;5;114m"a\\\\"\x1b[39m' +
        "\x1b[38;5;245m}\x1b[39m",
    );
  });

  it("is ANSI-safe with escaped quotes: stripping recovers the input", () => {
    const input = '{"q":"a \\"b\\" c"}';
    expect(stripAnsi(colorizeToolLine(input))).toBe(input);
  });
});
