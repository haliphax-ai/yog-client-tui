import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { STAGES, isStage, type Stage } from "../../../src/ui/pipeline/stages.ts";
import {
  hooksFor,
  register,
  registeredHooks,
  resetRegistryForTests,
} from "../../../src/ui/pipeline/registry.ts";
import { runPipeline } from "../../../src/ui/pipeline/runner.ts";

beforeEach(() => {
  resetRegistryForTests();
});

afterEach(() => {
  resetRegistryForTests();
  vi.useRealTimers();
});

describe("stage order", () => {
  it("declares the fixed stage order", () => {
    expect([...STAGES]).toEqual(["layout", "paint", "compose", "post", "emit"]);
  });

  it("freezes the order so it cannot be mutated at runtime", () => {
    expect(Object.isFrozen(STAGES)).toBe(true);
    expect(() => {
      (STAGES as string[]).push("layout");
    }).toThrow();
  });

  it("accepts only declared stage names", () => {
    expect(isStage("layout")).toBe(true);
    expect(isStage("post")).toBe(true);
    expect(isStage("render")).toBe(false);
    expect(isStage(42)).toBe(false);
  });

  it("runs core stage work in the declared order every frame", () => {
    const order: Stage[] = [];
    runPipeline({
      width: 10,
      setMetrics: () => order.push("layout"),
      paint: () => {
        order.push("paint");
        return ["x"];
      },
      emit: () => order.push("emit"),
    });
    expect(order).toEqual(["layout", "paint", "emit"]);
  });

  it("runs the full stage sequence layout → paint → compose → post → emit", () => {
    const seen: string[] = [];
    for (const stage of STAGES) {
      register(stage, (frame) => {
        seen.push(stage);
        return frame;
      });
    }
    runPipeline({ width: 4, paint: () => ["ab"] });
    expect(seen).toEqual(["layout", "paint", "compose", "post", "emit"]);
  });

  it("hands emit the padded frame and never runs anything after the write", () => {
    const duringPost: string[] = [];
    const atEmit: string[] = [];
    register("post", (frame) => {
      duringPost.push(frame);
      return frame;
    });
    register("emit", (frame) => {
      atEmit.push(frame);
      return `${frame}!`; // emit hooks run before the write
    });
    const written: string[] = [];
    runPipeline({
      width: 5,
      paint: () => ["ab", "cdefg"],
      emit: (frame) => written.push(frame),
    });
    // post core work padded the composed lines before its hooks ran
    expect(duringPost).toEqual(["ab   \ncdefg"]);
    // emit hook saw the padded frame and its output is what gets written
    expect(atEmit).toEqual(["ab   \ncdefg"]);
    expect(written).toEqual(["ab   \ncdefg!"]);
  });

  it("runs the pipeline exactly once per runPipeline call", () => {
    const emit = vi.fn();
    runPipeline({ width: 3, paint: () => ["x"], emit });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("refuses re-entrant runs", () => {
    expect(() =>
      runPipeline({
        width: 3,
        paint: () => ["x"],
        emit: () => runPipeline({ width: 3, paint: () => ["y"] }),
      }),
    ).toThrow(/re-entered/);
  });
});

describe("hooks", () => {
  it("runs hooks in registration order within a stage", () => {
    const seen: string[] = [];
    register("post", (frame) => {
      seen.push("first");
      return `${frame}1`;
    });
    register("post", (frame) => {
      seen.push("second");
      return `${frame}2`;
    });
    register("post", (frame) => {
      seen.push("third");
      return `${frame}3`;
    });

    const written: string[] = [];
    runPipeline({ width: 4, paint: () => ["ab"], emit: (f) => written.push(f) });
    expect(seen).toEqual(["first", "second", "third"]);
    // each hook saw the previous hook's output
    expect(written[0]).toBe("ab  123");
  });

  it("keeps per-stage hook lists isolated", () => {
    const removeCompose = register("compose", (f) => `${f}C`);
    register("post", (f) => `${f}P`);

    expect(hooksFor("compose")).toHaveLength(1);
    expect(hooksFor("post")).toHaveLength(1);
    expect(hooksFor("layout")).toHaveLength(0);

    removeCompose();
    expect(hooksFor("compose")).toHaveLength(0);
    expect(hooksFor("post")).toHaveLength(1);
  });

  it("exposes ordered arrays per stage via registeredHooks", () => {
    register("layout", (f) => f);
    register("layout", (f) => f);
    const snapshot = registeredHooks();
    expect([...STAGES].every((s) => Array.isArray(snapshot[s]))).toBe(true);
    expect(snapshot.layout).toHaveLength(2);
    expect(snapshot.emit).toHaveLength(0);
  });

  it("keeps registered hooks across frames without re-registering", () => {
    let runs = 0;
    register("paint", (frame) => {
      runs += 1;
      return frame;
    });
    runPipeline({ width: 3, paint: () => ["a"] });
    runPipeline({ width: 3, paint: () => ["a"] });
    expect(runs).toBe(2);
  });
});
