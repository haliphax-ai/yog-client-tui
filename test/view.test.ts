import { describe, expect, it } from "vitest";
import {
  colorizeToolLine,
  highlightBlock,
  prettyArgs,
  renderMarkdown,
  resultPreview,
  resultStatus,
  totalRows,
  type LogEntry,
} from "../src/ui/render/index.ts";
import { displayWidth, stripAnsi, wrapText } from "../src/util/ansi.ts";

/** Build a plain log entry with sensible defaults. */
const entry = (over: Partial<LogEntry>): LogEntry => ({
  kind: "system",
  lines: ["x"],
  ...over,
});

describe("prettyArgs", () => {
  it("serializes objects as compact whitespace-free JSON", () => {
    expect(prettyArgs({ b: 1, a: 2 }, 100)).toBe('{"b":1,"a":2}');
    expect(prettyArgs({ a: 1 }, 100, "compact")).toBe('{"a":1}');
  });

  it("collapses whitespace and trims string values", () => {
    expect(prettyArgs("  hello   world  ", 100)).toBe("hello world");
  });

  it("truncates to the limit with an ellipsis", () => {
    const out = prettyArgs("abcdefghijklmnopqrstuvwxyz0123456789", 12);
    expect(out).toBe("abcdefghijk…");
    expect(out.length).toBe(12);
    expect(out.endsWith("…")).toBe(true);
  });

  it("floors the limit at 12 cells even when max is smaller", () => {
    const out = prettyArgs("x".repeat(20), 5);
    expect(displayWidth(out)).toBe(12);
    expect(out).toBe("xxxxxxxxxxx…");
    // max below the floor still renders short values untouched
    expect(prettyArgs({ a: 1 }, 5)).toBe('{"a":1}');
  });

  it("caps by display width for wide characters", () => {
    expect(displayWidth(prettyArgs("x".repeat(30), 20))).toBe(20);
    expect(prettyArgs({ n: "你好世界" }, 100)).toBe('{"n":"你好世界"}');
  });

  it("leaves values under the limit untouched", () => {
    expect(prettyArgs("short", 100)).toBe("short");
  });

  it("pretty mode returns 2-space indented JSON with no cap", () => {
    expect(prettyArgs({ a: 1 }, 5, "pretty")).toBe('{\n  "a": 1\n}');
    expect(prettyArgs({ n: 1, s: "a b" }, 100, "pretty")).toBe(
      '{\n  "n": 1,\n  "s": "a b"\n}',
    );
  });

  it("pretty mode leaves raw strings untouched", () => {
    expect(prettyArgs("  hello   world  ", 100, "pretty")).toBe(
      "  hello   world  ",
    );
  });

  it("falls back to String() when JSON serialization fails", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(prettyArgs(circular, 100)).toBe("[object Object]");
  });

  it("stringifies non-serializable primitives", () => {
    expect(prettyArgs(undefined, 100)).toBe("undefined");
    expect(prettyArgs(null, 100, "pretty")).toBe("null");
  });
});

describe("wrapText", () => {
  it("wraps at the requested width on word boundaries", () => {
    expect(wrapText("hello world foo", 11)).toEqual(["hello world", "foo"]);
  });

  it("hard-breaks words longer than the width", () => {
    expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("preserves blank lines", () => {
    expect(wrapText("a\n\nb", 10)).toEqual(["a", "", "b"]);
  });

  it("returns a single empty row for an empty string", () => {
    expect(wrapText("", 10)).toEqual([""]);
  });

  it("returns an empty row when cols < 1", () => {
    expect(wrapText("hello", 0)).toEqual([""]);
  });

  it("keeps ANSI sequences attached and width-safe", () => {
    const rows = wrapText("\x1b[31mred text here\x1b[0m", 8);
    expect(rows.map((r) => stripAnsi(r))).toEqual(["red text", "here"]);
    expect(rows[0]).toContain("\x1b[31m");
    expect(rows[1]).toContain("\x1b[0m");
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(8);
  });

  it("wraps wide characters by cell width", () => {
    const rows = wrapText("wide chars 你好世界", 6);
    expect(rows.map((r) => stripAnsi(r))).toEqual(["wide", "chars", "你好世", "界"]);
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(6);
  });
});

describe("totalRows", () => {
  it("returns 0 for an empty log", () => {
    expect(totalRows([], 40)).toBe(0);
  });

  it("counts one row per logical line plus a separator", () => {
    expect(totalRows([entry({ lines: ["hi"] })], 40)).toBe(2);
    expect(totalRows([entry({ lines: ["a", "b"] })], 40)).toBe(3);
  });

  it("adds one separator row between entries", () => {
    expect(
      totalRows([entry({ lines: ["hi"] }), entry({ lines: ["x", "y"] })], 40),
    ).toBe(5);
  });

  it("counts wrapped rows", () => {
    expect(totalRows([entry({ lines: ["w".repeat(100)] })], 40)).toBe(4);
    expect(
      totalRows([entry({ lines: ["w".repeat(100), "w".repeat(100)] })], 40),
    ).toBe(7);
    expect(totalRows([entry({ lines: ["你好世界再见世界"] })], 6)).toBe(4);
  });

  it("counts a headerless entry as a single row", () => {
    expect(totalRows([entry({ lines: [] })], 40)).toBe(2);
  });

  it("counts chunk blocks including their vertical padding", () => {
    // header + 2 body rows + 1 padding row above/below + separator
    expect(
      totalRows(
        [entry({ kind: "chunk", lines: ["cmd exit 0", "l1", "l2"] })],
        40,
      ),
    ).toBe(6);
  });

  it("counts tool call lines as one row", () => {
    expect(
      totalRows(
        [
          entry({
            kind: "tool",
            lines: ['⚙️ run ✅ {"a":1}'],
            label: "⚙️ run ✅",
          }),
        ],
        40,
      ),
    ).toBe(2);
  });

  it("counts error entries", () => {
    expect(totalRows([entry({ kind: "error", lines: ["boom"] })], 40)).toBe(2);
  });
});

describe("highlightBlock", () => {
  it("returns non-blank styled rows for a JSON object", () => {
    const rows = highlightBlock({ a: 1, b: "two" }, 40);
    expect(rows).toBeDefined();
    const list = rows as string[];
    expect(list.length).toBeGreaterThan(0);
    for (const row of list) {
      expect(stripAnsi(row).trim()).not.toBe("");
      expect(displayWidth(row)).toBeLessThanOrEqual(40);
    }
    const plain = list.map((r) => stripAnsi(r)).join("\n");
    expect(plain).toContain('"a"');
    expect(plain).toContain('"two"');
  });

  it("caps every row to the requested width", () => {
    const rows = highlightBlock({ a: 1 }, 10) as string[];
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(10);
  });

  it("renders string values with the requested language", () => {
    const rows = highlightBlock("some *text* here", 40, "markdown");
    expect(rows).toBeDefined();
    const plain = (rows as string[]).map((r) => stripAnsi(r)).join("\n");
    expect(plain).toContain("some");
    expect(plain).toContain("here");
    for (const row of rows as string[]) {
      expect(displayWidth(row)).toBeLessThanOrEqual(40);
      expect(stripAnsi(row).trim()).not.toBe("");
    }
  });

  it("handles arrays and undefined values", () => {
    const arr = highlightBlock([1, 2], 40);
    expect(arr).toBeDefined();
    expect((arr as string[]).map((r) => stripAnsi(r)).join("\n")).toContain("1");
    // undefined stringifies to text rather than failing
    expect(highlightBlock(undefined, 40)).toBeDefined();
  });

  it("returns undefined for oversized input", () => {
    expect(highlightBlock("x".repeat(100_001), 40)).toBeUndefined();
  });

  it("accepts input right at the size limit", () => {
    expect(highlightBlock("x".repeat(100_000), 40)).toBeDefined();
  });
});

describe("renderMarkdown", () => {
  const sample = "# Title\n\nHello *world* paragraph.";

  it("produces stable structural rows for a small sample", () => {
    const rows = renderMarkdown(sample, 40);
    expect(rows.length).toBe(3);
    // outer glamour padding rows are stripped
    expect(stripAnsi(rows[0] ?? "").trim()).not.toBe("");
    expect(stripAnsi(rows[2] ?? "").trim()).not.toBe("");
    // the paragraph break survives as an interior blank row
    expect(rows[1]).toBe("");
    expect(stripAnsi(rows[0] ?? "")).toContain("Title");
    expect(stripAnsi(rows[2] ?? "")).toContain("Hello");
    expect(stripAnsi(rows[2] ?? "")).toContain("world");
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(40);
  });

  it("is deterministic for the same input", () => {
    expect(renderMarkdown(sample, 40)).toEqual(renderMarkdown(sample, 40));
    expect(renderMarkdown(sample, 40).join("\n")).toBe(
      renderMarkdown(sample, 40).join("\n"),
    );
  });

  it("returns [] for oversized input", () => {
    expect(renderMarkdown("x".repeat(100_001), 40)).toEqual([]);
  });

  it("keeps every row within the width budget", () => {
    const rows = renderMarkdown(
      "A paragraph with enough words that it must wrap across several lines at this width.",
      32,
    );
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(32);
  });
});

describe("resultStatus", () => {
  it("joins exit code and runtime", () => {
    expect(resultStatus({ exitCode: 0, runtimeMs: 42 })).toBe("exit 0 · 42ms");
  });

  it("renders the exit code alone", () => {
    expect(resultStatus({ exitCode: 1 })).toBe("exit 1");
  });

  it("renders runtime alone with its separator", () => {
    expect(resultStatus({ runtimeMs: 5 })).toBe(" · 5ms");
  });

  it("returns '' when neither field is a number", () => {
    expect(resultStatus({ stdout: "hi" })).toBe("");
    expect(resultStatus({ exitCode: "0" })).toBe("");
  });

  it("returns '' for non-object results", () => {
    expect(resultStatus(null)).toBe("");
    expect(resultStatus(undefined)).toBe("");
    expect(resultStatus("str")).toBe("");
    expect(resultStatus([1, 2])).toBe("");
  });
});

describe("resultPreview", () => {
  it("renders bash stdout/stderr as plain text rows", () => {
    expect(
      resultPreview({ stdout: "line1\nline2\n", stderr: "" }, 40),
    ).toEqual(["line1", "line2"]);
    expect(resultPreview({ stdout: "", stderr: "err line\n" }, 40)).toEqual([
      "err line",
    ]);
    // stdout rows come before stderr rows
    expect(resultPreview({ stdout: "a\nb", stderr: "e" }, 40)).toEqual([
      "a",
      "b",
      "e",
    ]);
  });

  it("returns [] when the bash output is blank", () => {
    expect(resultPreview({ stdout: "   ", stderr: "" }, 40)).toEqual([]);
  });

  it("falls back to highlighted JSON for other shapes", () => {
    const rows = resultPreview({ nope: true }, 40);
    expect(rows.length).toBeGreaterThan(0);
    const plain = rows.map((r) => stripAnsi(r)).join("\n");
    expect(plain).toContain('"nope"');
  });

  it("keeps every row within cols-2 cells", () => {
    for (const result of [
      { stdout: "one\ntwo" },
      { nope: true },
      "text result",
      null,
      undefined,
      [],
    ]) {
      for (const row of resultPreview(result, 40)) {
        expect(displayWidth(row)).toBeLessThanOrEqual(38);
      }
    }
  });

  it("renders scalar fallbacks as visible text", () => {
    expect(
      resultPreview("text result", 40).map((r) => stripAnsi(r)).join("\n"),
    ).toContain("text result");
    expect(
      resultPreview(undefined, 40).map((r) => stripAnsi(r)).join("\n"),
    ).toContain("undefined");
    expect(
      resultPreview(null, 40).map((r) => stripAnsi(r)).join("\n"),
    ).toContain("null");
  });

  it("returns [] for an empty string result", () => {
    expect(resultPreview("", 40)).toEqual([]);
  });
});

describe("colorizeToolLine", () => {
  it("colors JSON keys, values, numbers, and punctuation", () => {
    expect(colorizeToolLine('{"a":1}')).toBe(
      "\x1b[38;5;245m{\x1b[39m" +
        "\x1b[38;5;39m\"a\"\x1b[39m" +
        "\x1b[38;5;245m:\x1b[39m" +
        "\x1b[38;5;215m1\x1b[39m" +
        "\x1b[38;5;245m}\x1b[39m",
    );
  });

  it("colors literals and numbers in a full line", () => {
    expect(colorizeToolLine('a = {"key": [1, true, null], "s": "x"}')).toBe(
      "a = \x1b[38;5;245m{\x1b[39m\x1b[38;5;39m\"key\"\x1b[39m\x1b[38;5;245m:\x1b[39m " +
        "\x1b[38;5;245m[\x1b[39m\x1b[38;5;215m1\x1b[39m\x1b[38;5;245m,\x1b[39m " +
        "\x1b[38;5;213mtrue\x1b[39m\x1b[38;5;245m,\x1b[39m " +
        "\x1b[38;5;213mnull\x1b[39m\x1b[38;5;245m]\x1b[39m\x1b[38;5;245m,\x1b[39m " +
        "\x1b[38;5;39m\"s\"\x1b[39m\x1b[38;5;245m:\x1b[39m " +
        "\x1b[38;5;114m\"x\"\x1b[39m\x1b[38;5;245m}\x1b[39m",
    );
  });

  it("holds the row prefix and flushes it before the first token", () => {
    expect(colorizeToolLine("  ⚙️ run ✅ {}")).toBe(
      "  ⚙️ run \x1b[38;5;41m✅\x1b[39m \x1b[38;5;245m{\x1b[39m\x1b[38;5;245m}\x1b[39m",
    );
  });

  it("emits a prefix-only row unchanged", () => {
    expect(colorizeToolLine("prefix only  ")).toBe("prefix only  ");
    expect(colorizeToolLine("")).toBe("");
  });

  it("colors success and failure markers", () => {
    expect(colorizeToolLine("plain ❌ bad")).toBe(
      "plain \x1b[38;5;203m❌\x1b[39m bad",
    );
    expect(colorizeToolLine("a ✓ b ✗ c")).toBe(
      "a \x1b[38;5;41m✓\x1b[39m b \x1b[38;5;203m✗\x1b[39m c",
    );
  });

  it("leaves plain text without tokens untouched", () => {
    expect(colorizeToolLine("no color here")).toBe("no color here");
    expect(colorizeToolLine("trueish")).toBe("trueish");
  });

  it("copies pre-existing escape sequences through untouched", () => {
    expect(colorizeToolLine("\x1b[38;5;9mred ✅")).toBe(
      "\x1b[38;5;9mred \x1b[38;5;41m✅\x1b[39m",
    );
  });

  it("carries string color across a row split and re-emits it", () => {
    expect(colorizeToolLine('{"a":"value\ncontinued"}')).toBe(
      "\x1b[38;5;245m{\x1b[39m" +
        "\x1b[38;5;39m\"a\"\x1b[39m" +
        "\x1b[38;5;245m:\x1b[39m" +
        "\x1b[38;5;114m\"value\n" +
        "\x1b[38;5;114mcontinued" +
        "\x1b[38;5;114m\"\x1b[39m" +
        "\x1b[38;5;245m}\x1b[39m",
    );
  });

  it("colors negative/exponent numbers as a single token", () => {
    expect(colorizeToolLine("v=-3.5e2")).toBe(
      "v=\x1b[38;5;215m-3.5e2\x1b[39m",
    );
  });

  it("is ANSI-safe: stripping recovers the original text", () => {
    const input = 'a = {"key": [1, true, null], "s": "x"} ✅';
    expect(stripAnsi(colorizeToolLine(input))).toBe(input);
  });
});

describe("displayWidth / stripAnsi", () => {
  it("measures plain text", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("")).toBe(0);
  });

  it("ignores ANSI sequences when measuring", () => {
    expect(displayWidth("\x1b[31mabc\x1b[0m")).toBe(3);
    expect(displayWidth("a\x1b[1mb\x1b[0m你")).toBe(4);
  });

  it("counts wide characters as two cells", () => {
    expect(displayWidth("你好")).toBe(4);
    expect(displayWidth("a你b")).toBe(4);
  });

  it("ignores combining marks and zero-width characters", () => {
    expect(displayWidth("e\u0301")).toBe(1);
    expect(displayWidth("\u200b")).toBe(0);
  });

  it("strips CSI sequences with parameters", () => {
    expect(stripAnsi("\x1b[1;31mred\x1b[0m plain")).toBe("red plain");
  });

  it("leaves plain text unchanged", () => {
    expect(stripAnsi("no escapes")).toBe("no escapes");
    expect(stripAnsi("")).toBe("");
  });

  it("strips OSC title sequences", () => {
    expect(stripAnsi("before\x1b]0;title\x07after")).toBe("beforeafter");
  });
});