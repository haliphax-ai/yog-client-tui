import { beforeEach, describe, expect, it } from "vitest";
import { resetForTests, setState } from "../../../src/core/index.ts";

import {
  BaseComponent,
  type KeyResult,
  type RenderContext,
  type RenderResult,
} from "../../../src/ui/components/index.ts";
import {
  cycleFocus,
  getTopLevel,
  routeChar,
  routeKey,
  setTopLevel,
  type Globals,
} from "../../../src/ui/components/index.ts";

/** Stub component: declares a ring side, claims only keys/chars given. */
class Stub extends BaseComponent {
  readonly log: string[];
  id = "stub";
  private readonly claims: Set<string>;

  constructor(options: { ring: "log" | "input"; claims?: string[]; log?: string[] }) {
    super(true);
    this.ring = options.ring;
    this.log = options.log ?? [];
    this.claims = new Set(options.claims ?? []);
  }

  render(_ctx: RenderContext): RenderResult {
    return ["stub"];
  }

  override handleKey(seq: string): KeyResult {
    this.log.push(`key:${this.id}:${seq}`);
    return this.claims.has(seq) ? "handled" : "unhandled";
  }

  override handleChar(ch: string): KeyResult {
    this.log.push(`char:${this.id}:${ch}`);
    return this.claims.has(ch) ? "handled" : "unhandled";
  }

  protected override focusChanged(gain: boolean): void {
    this.log.push(`${gain ? "gain" : "loss"}:${this.id}`);
  }
}

/** Globals double: records which binding ran. */
function globalsSpy(rows = 24): { globals: Globals; calls: string[] } {
  const calls: string[] = [];
  const globals: Globals = {
    quit: () => calls.push("quit"),
    focusNext: () => calls.push("focusNext"),
    focusPrev: () => calls.push("focusPrev"),
    scrollBy: (delta) => calls.push(`scrollBy:${delta}`),
    jump: (top) => calls.push(`jump:${top}`),
    submit: () => calls.push("submit"),
    abortTurn: () => calls.push("abortTurn"),
    dismissEsc: () => false,
    abortBackgroundJobs: () => calls.push("abortBackgroundJobs"),
    toggleJobs: () => calls.push("toggleJobs"),
    pageRows: () => rows,
  };
  return { globals, calls };
}

describe("routeKey — ring target only, then globals", () => {
  beforeEach(() => {
    resetForTests();
    setTopLevel("input");
  });

  it("only the ring target's side sees keys", () => {
    const log: string[] = [];
    const inputSide = new Stub({ ring: "input", claims: ["k"], log });
    inputSide.id = "input";
    const logSide = new Stub({ ring: "log", claims: ["k"], log });
    logSide.id = "log";

    expect(routeKey([logSide, inputSide], "k", globalsSpy().globals)).toBe(true);
    expect(log).toEqual(["key:input:k"]); // log never saw the key

    log.length = 0;
    setTopLevel("log");
    expect(routeKey([logSide, inputSide], "k", globalsSpy().globals)).toBe(true);
    expect(log).toEqual(["key:log:k"]); // input never saw the key
  });

  it("components without a ring never receive keys", () => {
    const log: string[] = [];
    const orphan = new Stub({ ring: "log", claims: ["k"], log });
    orphan.id = "orphan";
    orphan.ring = undefined;
    const inputSide = new Stub({ ring: "input", claims: ["k"], log });
    inputSide.id = "input";
    expect(routeKey([orphan, inputSide], "k", globalsSpy().globals)).toBe(true);
    expect(log).toEqual(["key:input:k"]);
  });

  it("bubbles unhandled keys between same-side components, then stops", () => {
    const log: string[] = [];
    const first = new Stub({ ring: "log", log });
    first.id = "first";
    const second = new Stub({ ring: "log", claims: ["\x1b[5~"], log });
    second.id = "second";
    setTopLevel("log");
    const { globals, calls } = globalsSpy();

    expect(routeKey([first, second], "\x1b[5~", globals)).toBe(true);
    expect(log).toEqual(["key:first:\x1b[5~", "key:second:\x1b[5~"]);
    expect(calls).toEqual([]); // handled downstream: globals never ran
  });

  it("falls through to the log-side globals when no component claims", () => {
    const log: string[] = [];
    const a = new Stub({ ring: "log", log });
    a.id = "a";
    setTopLevel("log");
    const { globals, calls } = globalsSpy();

    expect(routeKey([a], "\x1b[Z", globals)).toBe(true); // Shift+Tab
    expect(calls).toEqual(["focusPrev"]);
    expect(routeKey([a], "\x1b[6~", globals)).toBe(true); // PageDown
    expect(calls).toEqual(["focusPrev", "scrollBy:24"]);
    expect(routeKey([a], "\x1b[H", globals)).toBe(true); // Home → top
    expect(calls).toEqual(["focusPrev", "scrollBy:24", "jump:true"]);
  });

  it("Shift+Tab cycles the log backward only while the log holds the ring", () => {
    const a = new Stub({ ring: "log" });
    const { globals, calls } = globalsSpy();

    setTopLevel("input"); // input side holds the ring
    expect(routeKey([a], "\x1b[Z", globals)).toBe(false); // dropped
    expect(calls).toEqual([]); // log focus ring untouched

    setTopLevel("log");
    expect(routeKey([a], "\x1b[Z", globals)).toBe(true);
    expect(calls).toEqual(["focusPrev"]);
  });

  it("log-side navigation bindings never fire while the input holds the ring", () => {
    const a = new Stub({ ring: "log" });
    const { globals, calls } = globalsSpy();

    setTopLevel("input");
    for (const seq of [
      "\x1b[Z", // Shift+Tab
      "\x1b[H", // Home
      "\x1b[F", // End
      "\x1b[5~", // PageUp
      "\x1b[6~", // PageDown
      "\x1b[1;5H", // Ctrl+Home
    ]) {
      expect(routeKey([a], seq, globals)).toBe(false);
    }
    expect(calls).toEqual([]); // no log navigation ran
  });

  it("single-line Up/Down from the input still scroll the log (carve-out)", () => {
    const a = new Stub({ ring: "log" });
    const { globals, calls } = globalsSpy();

    setTopLevel("input");
    expect(routeKey([a], "\x1b[A", globals)).toBe(true); // Up
    expect(routeKey([a], "\x1b[B", globals)).toBe(true); // Down
    expect(calls).toEqual(["scrollBy:-1", "scrollBy:1"]);
  });

  it("the page size comes from the injected terminal height", () => {
    const a = new Stub({ ring: "log" });
    setTopLevel("log");
    const { globals, calls } = globalsSpy(10);
    expect(routeKey([a], "\x1b[5~", globals)).toBe(true); // PageUp
    expect(calls).toEqual(["scrollBy:-10"]);
  });
});

describe("routeChar — ring target only, then gated globals", () => {
  beforeEach(() => {
    resetForTests();
    setTopLevel("input");
  });

  it("a component claim on the ring side stops the walk", () => {
    const log: string[] = [];
    const focused = new Stub({ ring: "input", claims: ["e"], log });
    focused.id = "input";
    setTopLevel("input");
    const { globals, calls } = globalsSpy();

    expect(routeChar([focused], "e", globals)).toBe(true);
    expect(log).toEqual(["char:input:e"]);
    expect(calls).toEqual([]);
  });

  it("Enter submits only while the input holds the ring", () => {
    const inputSide = new Stub({ ring: "input" });
    const logSide = new Stub({ ring: "log" });
    const { globals, calls } = globalsSpy();

    setTopLevel("input");
    expect(routeChar([logSide, inputSide], "\r", globals)).toBe(true);
    expect(calls).toEqual(["submit"]);

    setTopLevel("log");
    calls.length = 0;
    expect(routeChar([logSide, inputSide], "\r", globals)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("Tab cycles entries only while the log holds the ring", () => {
    const inputSide = new Stub({ ring: "input" });
    const logSide = new Stub({ ring: "log" });
    const { globals, calls } = globalsSpy();

    setTopLevel("log");
    expect(routeChar([logSide, inputSide], "\t", globals)).toBe(true);
    expect(calls).toEqual(["focusNext"]);

    setTopLevel("input");
    calls.length = 0;
    expect(routeChar([logSide, inputSide], "\t", globals)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("Esc walks the cascade only while the input holds the ring", () => {
    const inputSide = new Stub({ ring: "input" });
    const logSide = new Stub({ ring: "log" });
    const { globals, calls } = globalsSpy();

    // Idle, nothing else to close: the background-jobs arm fires.
    setTopLevel("input");
    expect(routeChar([logSide, inputSide], "\x1b", globals)).toBe(true);
    expect(calls).toEqual(["abortBackgroundJobs"]);

    // A live turn outranks it: abortTurn, and the cascade stops.
    calls.length = 0;
    setState({ busy: true });
    expect(routeChar([logSide, inputSide], "\x1b", globals)).toBe(true);
    expect(calls).toEqual(["abortTurn"]);
    setState({ busy: false });

    // A drawer item that listens for Esc outranks everything: the cascade
    // stops there (no abort of any kind).
    calls.length = 0;
    const dismiss = globalsSpy();
    dismiss.globals.dismissEsc = () => true;
    expect(routeChar([logSide, inputSide], "\x1b", dismiss.globals)).toBe(true);
    expect(dismiss.calls).toEqual([]);

    // The log side never sees Esc (dropped, like every unhandled key).
    setTopLevel("log");
    calls.length = 0;
    expect(routeChar([logSide, inputSide], "\x1b", globals)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("Ctrl+C is unbound: dropped without running any global binding", () => {
    const a = new Stub({ ring: "input" });
    const b = new Stub({ ring: "log" });
    const { globals, calls } = globalsSpy();
    expect(routeChar([a, b], "\x03", globals)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("getTopLevel reflects the current ring target", () => {
    setTopLevel("log");
    expect(getTopLevel()).toBe("log");
    setTopLevel("input");
    expect(getTopLevel()).toBe("input");
  });
});

describe("cycleFocus — loss before gain, with wrap", () => {
  it("fires the loss of the outgoing component before the gain of the incoming one", () => {
    const log: string[] = [];
    const a = new Stub({ ring: "input", log });
    a.id = "a";
    const b = new Stub({ ring: "input", log });
    b.id = "b";
    a.onFocus(true);
    log.length = 0;

    cycleFocus([a, b], 1);
    expect(log).toEqual(["loss:a", "gain:b"]);
    expect(a.isFocused).toBe(false);
    expect(b.isFocused).toBe(true);
  });

  it("wraps forward from the last entry to the first and backward again", () => {
    const a = new Stub({ ring: "input" });
    a.id = "a";
    const b = new Stub({ ring: "input" });
    b.id = "b";

    cycleFocus([a, b], 1); // nothing focused → first
    expect([a.isFocused, b.isFocused]).toEqual([true, false]);
    cycleFocus([a, b], 1); // a → b
    expect([a.isFocused, b.isFocused]).toEqual([false, true]);
    cycleFocus([a, b], 1); // wrap: b → a
    expect([a.isFocused, b.isFocused]).toEqual([true, false]);
    cycleFocus([a, b], -1); // backward wrap: a → b
    expect([a.isFocused, b.isFocused]).toEqual([false, true]);
  });
});

describe("Ctrl+J on the input ring (kitty CSI-u)", () => {
  beforeEach(() => {
    resetForTests();
    setTopLevel("input");
  });

  it("Shift+Tab cycles the entry ring in its kitty encoding too", () => {
    const { globals, calls } = globalsSpy();
    setTopLevel("log");
    expect(routeKey([], "\x1b[9;2u", globals)).toBe(true);
    expect(calls).toEqual(["focusPrev"]);
    calls.length = 0;
    expect(routeKey([], "\x1b[27;2u", globals)).toBe(true);
    expect(calls).toEqual(["focusPrev"]);
  });

  it("routes the CSI-u ctrl+j sequence to toggleJobs while typing", () => {
    const { globals, calls } = globalsSpy();
    expect(routeKey([], "\x1b[106;5u", globals)).toBe(true);
    expect(calls).toEqual(["toggleJobs"]);
  });

  it("routes the kitty CSI 27u Esc sequence through the cascade while typing", () => {
    // With the kitty keyboard protocol pushed (flag 1), Esc arrives as the
    // CSI 27u SEQUENCE — the plain \x1b byte never reaches routeChar.
    const { globals, calls } = globalsSpy();
    expect(routeKey([], "\x1b[27u", globals)).toBe(true);
    expect(calls).toEqual(["abortBackgroundJobs"]);
  });

  it("keeps plain Enter on submit (the legacy encoding must not collide)", () => {
    const { globals, calls } = globalsSpy();
    expect(routeChar([], "\r", globals)).toBe(true);
    expect(calls).toEqual(["submit"]);
    expect(routeChar([], "\n", globals)).toBe(true);
    expect(calls).toEqual(["submit", "submit"]);
  });
});
