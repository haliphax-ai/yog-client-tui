import { describe, expect, it } from "vitest";

import {
  BaseComponent,
  type KeyResult,
  type RenderContext,
  type RenderResult,
} from "../../../src/ui/components/Component.ts";
import {
  cycleFocus,
  routeChar,
  routeKey,
  type Globals,
  type Routed,
} from "../../../src/ui/components/keyRouter.ts";

/** Stub component: claims only the keys/chars given, records every call. */
class Stub extends BaseComponent {
  readonly log: string[];
  id = "stub";
  private readonly claims: Set<string>;

  constructor(options: { focusable?: boolean; claims?: string[]; log?: string[] } = {}) {
    super(options.focusable ?? false);
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
function globalsSpy(): { globals: Globals; calls: string[] } {
  const calls: string[] = [];
  const globals: Globals = {
    quit: () => calls.push("quit"),
    focusNext: () => calls.push("focusNext"),
    focusPrev: () => calls.push("focusPrev"),
    scrollBy: (delta) => calls.push(`scrollBy:${delta}`),
    jump: (top) => calls.push(`jump:${top}`),
    submit: () => calls.push("submit"),
    abortTurn: () => calls.push("abortTurn"),
  };
  return { globals, calls };
}

describe("routeKey — focused first, then bubble, then globals", () => {
  it("offers the key to the focused component first even when a later one claims it", () => {
    const log: string[] = [];
    const first = new Stub({ log, claims: ["k"] });
    first.id = "first";
    const second = new Stub({ log, claims: ["k"] });
    second.id = "second";
    second.onFocus(true);
    log.length = 0; // drop the focus-transition entry
    const { globals, calls } = globalsSpy();

    expect(routeKey([first, second], "k", globals)).toBe(true);
    // Focused (second) answered first; first never saw the key.
    expect(log).toEqual(["key:second:k"]);
    expect(calls).toEqual([]);
  });

  it("bubbles an unhandled key to the next component, then stops", () => {
    const log: string[] = [];
    const focused = new Stub({ log });
    focused.id = "focused";
    focused.onFocus(true);
    const next = new Stub({ log, claims: ["\x1b[5~"] });
    next.id = "next";
    log.length = 0;
    const { globals, calls } = globalsSpy();

    expect(routeKey([focused, next], "\x1b[5~", globals)).toBe(true);
    expect(log).toEqual(["key:focused:\x1b[5~", "key:next:\x1b[5~"]);
    expect(calls).toEqual([]); // handled downstream: globals never ran
  });

  it("falls through to the globals when no component claims the key", () => {
    const log: string[] = [];
    const a = new Stub({ log });
    a.id = "a";
    a.onFocus(true);
    const b = new Stub({ log });
    b.id = "b";
    log.length = 0;
    const { globals, calls } = globalsSpy();

    expect(routeKey([a, b], "\x1b[Z", globals)).toBe(true); // Shift+Tab
    expect(calls).toEqual(["focusPrev"]);
    expect(routeKey([a, b], "\x1b[6~", globals)).toBe(true); // PageDown
    expect(calls).toEqual(["focusPrev", `scrollBy:${process.stdout.rows ?? 24}`]);
  });
});

describe("routeChar — same ordering as routeKey", () => {
  it("bubbles unclaimed chars through the chain and into the globals", () => {
    const log: string[] = [];
    const focused = new Stub({ log, claims: ["e"] });
    focused.id = "focused";
    focused.onFocus(true);
    const next = new Stub({ log });
    next.id = "next";
    log.length = 0;
    const { globals, calls } = globalsSpy();

    // Component claim stops the walk.
    expect(routeChar([focused, next], "e", globals)).toBe(true);
    expect(log).toEqual(["char:focused:e"]);

    // Enter bubbles past both components → global submit.
    log.length = 0;
    expect(routeChar([focused, next], "\r", globals)).toBe(true);
    expect(log).toEqual(["char:focused:\r", "char:next:\r"]);
    expect(calls).toEqual(["submit"]);
  });

  it("routes Esc with no focused entry to the global abort binding", () => {
    const a = new Stub();
    const b = new Stub();
    const { globals, calls } = globalsSpy();

    expect(routeChar([a, b], "\x1b", globals)).toBe(true);
    expect(calls).toEqual(["abortTurn"]);
  });

  it("does not reach the global abort when a component claims Esc", () => {
    const log: string[] = [];
    const claimer = new Stub({ log, claims: ["\x1b"] });
    claimer.id = "claimer";
    const { globals, calls } = globalsSpy();
    expect(routeChar([claimer], "\x1b", globals)).toBe(true);
    expect(log).toEqual(["char:claimer:\x1b"]);
    expect(calls).toEqual([]);
  });
});

describe("cycleFocus — loss before gain, with wrap", () => {
  it("fires the loss of the outgoing component before the gain of the incoming one", () => {
    const log: string[] = [];
    const a = new Stub({ focusable: true, log });
    a.id = "a";
    const b = new Stub({ focusable: true, log });
    b.id = "b";
    const ring: Routed[] = [
      { id: "a", component: a },
      { id: "b", component: b },
    ];
    a.onFocus(true);
    log.length = 0;

    cycleFocus(ring, 1);
    expect(log).toEqual(["loss:a", "gain:b"]);
    expect(a.isFocused).toBe(false);
    expect(b.isFocused).toBe(true);
  });

  it("wraps forward from the last entry to the first and backward again", () => {
    const a = new Stub({ focusable: true });
    a.id = "a";
    const b = new Stub({ focusable: true });
    b.id = "b";
    const ring: Routed[] = [
      { id: "a", component: a },
      { id: "b", component: b },
    ];

    cycleFocus(ring, 1); // nothing focused → first
    expect([a.isFocused, b.isFocused]).toEqual([true, false]);
    cycleFocus(ring, 1); // a → b
    expect([a.isFocused, b.isFocused]).toEqual([false, true]);
    cycleFocus(ring, 1); // wrap: b → a
    expect([a.isFocused, b.isFocused]).toEqual([true, false]);
    cycleFocus(ring, -1); // backward wrap: a → b
    expect([a.isFocused, b.isFocused]).toEqual([false, true]);
  });
});