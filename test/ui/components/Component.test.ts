import { describe, expect, it } from "vitest";

import {
  BaseComponent,
  measureRows,
  type Component,
  type RenderContext,
  type RenderResult,
} from "../../../src/ui/components/Component.ts";

/** Minimal concrete component with configurable rows and key handling. */
class Stub extends BaseComponent {
  rows: string[];
  handled: Set<string>;

  constructor(options: { focusable?: boolean; rows?: string[]; handle?: string[] } = {}) {
    super(options.focusable ?? false);
    this.rows = options.rows ?? ["a", "b", "c"];
    this.handled = new Set(options.handle ?? []);
  }

  render(_ctx: RenderContext): RenderResult {
    return this.rows;
  }

  override handleKey(seq: string): "handled" | "unhandled" {
    return this.handled.has(seq) ? "handled" : "unhandled";
  }

  override handleChar(ch: string): "handled" | "unhandled" {
    return this.handled.has(ch) ? "handled" : "unhandled";
  }
}

/** A component that renders one frame string instead of rows. */
class FrameStub extends BaseComponent {
  render(): RenderResult {
    return "one\ntwo";
  }
}

/** The planned routing shape: focused component first, then bubbling. */
function dispatchChar(chain: readonly Component[], ch: string): number {
  for (let i = 0; i < chain.length; i++) {
    if ((chain[i] as Component).handleChar(ch) === "handled") return i;
  }
  return -1; // global bindings
}

function dispatchKey(chain: readonly Component[], seq: string): number {
  for (let i = 0; i < chain.length; i++) {
    if ((chain[i] as Component).handleKey(seq) === "handled") return i;
  }
  return -1;
}

describe("BaseComponent — handled/unhandled propagation", () => {
  it("defaults to unhandled for keys and chars when a subclass adds no bindings", () => {
    const stub = new Stub();
    expect(stub.handleKey("\x1b[A")).toBe("unhandled");
    expect(stub.handleChar("x")).toBe("unhandled");
    expect(stub.handleChar("\t")).toBe("unhandled");
  });

  it("reports handled for sequences the subclass claims", () => {
    const stub = new Stub({ handle: ["\x1b[A", "x"] });
    expect(stub.handleKey("\x1b[A")).toBe("handled");
    expect(stub.handleChar("x")).toBe("handled");
    expect(stub.handleKey("\x1b[B")).toBe("unhandled");
    expect(stub.handleChar("y")).toBe("unhandled");
  });

  it("bubbles an unhandled char down the chain and stops at the first handler", () => {
    const focused = new Stub({ handle: ["z"] });
    const next = new Stub({ handle: ["z"] });
    const chain = [focused, next];
    expect(dispatchChar(chain, "z")).toBe(0); // handled in place, no bubble
    expect(dispatchChar(chain, "q")).toBe(-1); // nothing claimed it → global
  });

  it("bubbles unhandled key sequences the same way", () => {
    const focused = new Stub();
    const global = new Stub({ handle: ["\x1b[5~"] });
    const chain = [focused, global];
    expect(dispatchKey(chain, "\x1b[5~")).toBe(1); // focused passed it on
    expect(dispatchKey(chain, "\x1b[6~")).toBe(-1); // nobody wants it
  });
});

describe("BaseComponent — focus gain/loss ordering", () => {
  it("updates isFocused before invoking the subclass hook", () => {
    const observed: [boolean, boolean][] = [];
    class Observed extends Stub {
      protected override focusChanged(gain: boolean): void {
        observed.push([gain, this.isFocused]);
      }
    }
    const stub = new Observed({ focusable: true });
    expect(stub.isFocused).toBe(false);

    stub.onFocus(true);
    expect(observed).toEqual([[true, true]]); // hook sees the new state

    stub.onFocus(false);
    expect(observed).toEqual([
      [true, true],
      [false, false],
    ]);
  });

  it("exposes focus transitions in gain-then-loss order through repeated onFocus", () => {
    const log: string[] = [];
    class Logged extends Stub {
      protected override focusChanged(gain: boolean): void {
        log.push(gain ? "gain" : "loss");
      }
    }
    const stub = new Logged({ focusable: true });
    stub.onFocus(true);
    expect(stub.isFocused).toBe(true);
    stub.onFocus(false);
    expect(stub.isFocused).toBe(false);
    expect(log).toEqual(["gain", "loss"]);
  });

  it("does not flip isFocused when focus never arrives", () => {
    const stub = new Stub({ focusable: true });
    expect(stub.isFocused).toBe(false);
    expect(stub.focusable).toBe(true);
  });
});

describe("BaseComponent — focusable flag", () => {
  it("defaults to non-focusable and passes through the constructor", () => {
    expect(new Stub().focusable).toBe(false);
    expect(new Stub({ focusable: true }).focusable).toBe(true);
  });
});

describe("BaseComponent — measure", () => {
  it("counts rows for row-array renders", () => {
    const stub = new Stub({ rows: ["a", "b", "c"] });
    expect(stub.measure(40)).toBe(3);
    stub.rows = ["only"];
    expect(stub.measure(40)).toBe(1);
  });

  it("splits frame-string renders on newlines", () => {
    const stub = new FrameStub();
    expect(stub.measure(80)).toBe(2);
  });

  it("clamps a degenerate frame string to zero rows", () => {
    class Empty extends BaseComponent {
      render(): RenderResult {
        return "";
      }
    }
    expect(new Empty().measure(80)).toBe(0);
  });

  it("passes a sane width into render context (floored, never negative)", () => {
    const seen: number[] = [];
    class Seen extends BaseComponent {
      render(ctx: RenderContext): RenderResult {
        seen.push(ctx.cols);
        return ["x"];
      }
    }
    const stub = new Seen();
    expect(stub.measure(40.7)).toBe(1);
    expect(stub.measure(-5)).toBe(1);
    expect(seen).toEqual([40, 0]);
  });
});

describe("measureRows helper", () => {
  it("counts array rows directly and splits strings", () => {
    expect(measureRows(["a", "b"])).toBe(2);
    expect(measureRows("x\ny\nz")).toBe(3);
    expect(measureRows("single")).toBe(1);
  });
});

describe("lifecycle hooks", () => {
  it("are optional: base no-ops exist and subclasses may override", () => {
    const plain = new Stub();
    expect(() => plain.mount()).not.toThrow();
    expect(() => plain.unmount()).not.toThrow();

    const calls: string[] = [];
    class Tracked extends Stub {
      override mount(): void {
        calls.push("mount");
      }
      override unmount(): void {
        calls.push("unmount");
      }
    }
    const stub = new Tracked();
    // The router only calls them when present on the component type.
    stub.mount?.();
    stub.unmount?.();
    expect(calls).toEqual(["mount", "unmount"]);
  });
});
