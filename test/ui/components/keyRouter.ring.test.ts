import { beforeEach, describe, expect, it } from "vitest";

import {
  BaseComponent,
  type KeyResult,
  type RenderContext,
  type RenderResult,
} from "../../../src/ui/components/Component.ts";
import {
  getTopLevel,
  routeChar,
  routeKey,
  setTopLevel,
  type Globals,
} from "../../../src/ui/components/keyRouter.ts";

/** Ring member stub: logs visits, claims configured seq/chars. */
class RingStub extends BaseComponent {
  readonly log: string[];
  id: string;
  private readonly claims: Set<string>;
  constructor(options: { ring: "log" | "input"; claims?: string[]; log?: string[] }) {
    super(true);
    this.ring = options.ring;
    this.log = options.log ?? [];
    this.id = options.ring;
    this.claims = new Set(options.claims ?? []);
  }
  render(_ctx: RenderContext): RenderResult {
    return "stub";
  }
  override handleKey(seq: string): KeyResult {
    this.log.push(`key:${this.id}:${seq}`);
    return this.claims.has(seq) ? "handled" : "unhandled";
  }
  override handleChar(ch: string): KeyResult {
    this.log.push(`char:${this.id}:${ch}`);
    return this.claims.has(ch) ? "handled" : "unhandled";
  }
}

function spyGlobals() {
  const calls: string[] = [];
  const globals: Globals = {
    quit: () => calls.push("quit"),
    focusNext: () => calls.push("focusNext"),
    focusPrev: () => calls.push("focusPrev"),
    scrollBy: (d) => calls.push(`scrollBy:${d}`),
    jump: (t) => calls.push(`jump:${t}`),
    submit: () => calls.push("submit"),
    abortTurn: () => calls.push("abortTurn"),
    pageRows: () => 24,
  };
  return { globals, calls };
}

describe("top-level focus ring", () => {
  beforeEach(() => {
    setTopLevel("input");
  });

  it("defaults the ring target to the input", () => {
    expect(getTopLevel()).toBe("input");
  });

  it("routes keys only to the ring target side", () => {
    const log: string[] = [];
    const chain = [
      new RingStub({ ring: "log", log }),
      new RingStub({ ring: "input", claims: ["x"], log }),
    ];
    setTopLevel("input");
    expect(routeChar(chain, "x", spyGlobals().globals)).toBe(true);
    expect(log).toEqual(["char:input:x"]); // log never saw the key

    log.length = 0;
    setTopLevel("log");
    expect(routeChar(chain, "x", spyGlobals().globals)).toBe(false); // dropped
    expect(log).toEqual(["char:log:x"]); // input never saw the key
  });

  it("Enter submits only while the input holds the ring", () => {
    const chain = [new RingStub({ ring: "log" }), new RingStub({ ring: "input" })];
    setTopLevel("input");
    const input = spyGlobals();
    expect(routeChar(chain, "\r", input.globals)).toBe(true);
    expect(input.calls).toEqual(["submit"]);

    setTopLevel("log");
    const logSide = spyGlobals();
    expect(routeChar(chain, "\r", logSide.globals)).toBe(false);
    expect(logSide.calls).toEqual([]);
  });

  it("Tab cycles entries only while the log holds the ring", () => {
    const chain = [new RingStub({ ring: "log" }), new RingStub({ ring: "input" })];
    setTopLevel("log");
    const logSide = spyGlobals();
    expect(routeChar(chain, "\t", logSide.globals)).toBe(true);
    expect(logSide.calls).toEqual(["focusNext"]);

    setTopLevel("input");
    const input = spyGlobals();
    expect(routeChar(chain, "\t", input.globals)).toBe(false);
    expect(input.calls).toEqual([]);
  });

  it("log-side navigation globals (Home/End) run on the log ring", () => {
    const chain = [new RingStub({ ring: "log" }), new RingStub({ ring: "input" })];
    setTopLevel("log");
    const logSide = spyGlobals();
    expect(routeKey(chain, "\x1b[H", logSide.globals)).toBe(true);
    expect(logSide.calls).toEqual(["jump:true"]);
  });
});
