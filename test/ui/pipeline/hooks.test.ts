import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { padFrame } from "../../../src/ui/pipeline/lines.ts";
import {
  hooksFor,
  register,
  resetRegistryForTests,
} from "../../../src/ui/pipeline/registry.ts";
import { runPipeline } from "../../../src/ui/pipeline/runner.ts";

/**
 * Existing rendered scenarios used for byte-identity checks: plain rows,
 * ANSI-styled rows, overlong-line truncation, blank lines, and an empty
 * frame. Each mirrors an output shape the app already produces.
 */
const SCENARIOS: ReadonlyArray<{
  name: string;
  width: number;
  lines: readonly string[];
}> = [
  { name: "plain rows", width: 20, lines: ["hello", "world"] },
  {
    name: "ANSI-styled rows",
    width: 20,
    lines: ["\x1b[31merror\x1b[0m boom", "\x1b[1;32mok\x1b[0m fine"],
  },
  { name: "overlong line truncation", width: 8, lines: ["0123456789abcdef"] },
  { name: "blank line in the middle", width: 12, lines: ["a", "", "b"] },
  { name: "no rows at all", width: 10, lines: [] },
];

/** Run one frame with a fixed scene and capture the bytes emit would write. */
function renderFrame(width: number, lines: readonly string[]): string {
  let written = "";
  runPipeline({
    width,
    paint: () => [...lines],
    emit: (frame) => {
      written = frame;
    },
  });
  return written;
}

/** Byte-level equality (not just string equality by accident). */
function expectByteIdentical(actual: string, expected: string): void {
  expect(Buffer.from(actual, "utf8").equals(Buffer.from(expected, "utf8"))).toBe(
    true,
  );
}

/**
 * A stand-in for a real feature (a floating overlay or status widget):
 * installed purely by calling `register("post", ...)` from this test file —
 * no production module is touched. It stamps a badge over the padded right
 * edge of the top line, exactly as a corner overlay would.
 */
function installCornerOverlay(
  label: string,
  width: number,
  seen: string[],
): () => void {
  const badge = `[${label}]`;
  return register("post", (frame) => {
    seen.push(frame);
    const lines = frame.split("\n");
    const first = lines[0] ?? "";
    lines[0] = first.slice(0, width - badge.length) + badge;
    return lines.join("\n");
  });
}

beforeEach(() => {
  resetRegistryForTests();
});

afterEach(() => {
  resetRegistryForTests();
});

describe("dummy overlay hooks into post without touching core files", () => {
  it("sees the already-padded frame and draws over the composed output", () => {
    const width = 20;
    const lines = ["status line here", "body"];
    const baseline = renderFrame(width, lines);

    const seen: string[] = [];
    const remove = installCornerOverlay("live", width, seen);
    expect(hooksFor("post")).toHaveLength(1); // registered purely from this test

    const withOverlay = renderFrame(width, lines);
    expect(seen).toEqual([baseline]); // post core work ran before the hook
    expect(withOverlay).not.toBe(baseline);

    const [top = "", body = ""] = withOverlay.split("\n");
    expect(top).toBe("status line he[live]");
    expect(body).toBe("body".padEnd(width)); // other lines untouched
    for (const line of withOverlay.split("\n")) {
      expect(line).toHaveLength(width); // frame still normalized to width
    }

    remove();
    expect(hooksFor("post")).toHaveLength(0);
    expectByteIdentical(renderFrame(width, lines), baseline);
  });

  it("runs feature hooks in declared registration order", () => {
    const order: string[] = [];
    register("post", (frame) => {
      order.push("overlay");
      return `${frame}\noverlay`;
    });
    register("post", (frame) => {
      order.push("widget");
      return `${frame}|widget`;
    });

    const written = renderFrame(6, ["ab"]);
    expect(order).toEqual(["overlay", "widget"]);
    // the second feature observed the first feature's output
    expect(written).toBe("ab    \noverlay|widget");
  });

  it("keeps a feature hook out of other stages' work", () => {
    const stages: string[] = [];
    register("post", (frame) => {
      stages.push("post");
      return frame;
    });
    renderFrame(4, ["xy"]);
    expect(stages).toEqual(["post"]); // exactly once, only in post
  });
});

describe("rendering stays byte-identical with an empty hook list", () => {
  it.each(SCENARIOS)(
    "is byte-identical for $name before and after registering/unregistering a hook",
    ({ width, lines }) => {
      const baseline = renderFrame(width, lines);
      const remove = register("post", (frame) => `${frame}\nadded`);
      expect(renderFrame(width, lines)).not.toBe(baseline); // the hook did change it
      remove();
      expectByteIdentical(renderFrame(width, lines), baseline);
    },
  );

  it.each(SCENARIOS)(
    "is byte-identical for $name once every stage is reset to an empty registry",
    ({ width, lines }) => {
      const baseline = renderFrame(width, lines);
      for (const stage of ["layout", "paint", "compose", "post", "emit"] as const) {
        register(stage, (frame) => `${frame}!`);
      }
      expect(renderFrame(width, lines)).not.toBe(baseline);
      resetRegistryForTests();
      expectByteIdentical(renderFrame(width, lines), baseline);
    },
  );

  it.each(SCENARIOS)(
    "is byte-identical for $name with pass-through hooks on every stage",
    ({ width, lines }) => {
      const baseline = renderFrame(width, lines);
      for (const stage of ["layout", "paint", "compose", "post", "emit"] as const) {
        register(stage, (frame) => frame);
      }
      expectByteIdentical(renderFrame(width, lines), baseline);
    },
  );

  it("is deterministic across repeated runs with no hooks registered", () => {
    for (const { width, lines } of SCENARIOS) {
      expect(renderFrame(width, lines)).toBe(renderFrame(width, lines));
    }
  });
});

describe("post hooks compose with core padding", () => {
  it("receives every line padded to the target width", () => {
    const received: string[] = [];
    register("post", (frame) => {
      received.push(frame);
      return frame;
    });
    renderFrame(5, ["ab", "cdefg", "xy"]);
    expect(received).toEqual([padFrame("ab\ncdefg\nxy", 5)]);
    expect((received[0] ?? "").split("\n").map((l) => l.length)).toEqual([5, 5, 5]);
  });

  it("can re-normalize the frame after appending a widget row", () => {
    register("post", (frame) => padFrame(`${frame}\nnoise`, 6));
    const written = renderFrame(6, ["ab"]);
    expect(written.split("\n")).toEqual(["ab    ", "noise "]);
  });
});