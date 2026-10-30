import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { statusBody } from "../../../src/ui/components/StatusComponent.ts";
import { resetForTests, setState } from "../../../src/core/store.ts";

/** Collect one status line body, then restore the default store. */
function body(patch: Parameters<typeof setState>[0]): string {
  setState(patch);
  return statusBody();
}

describe("statusBody", () => {
  afterEach(() => {
    resetForTests();
  });

  it("shows the session and hint segments separated by a vertical bar", () => {
    const out = body({ statusNote: "", busy: false, model: "m-1", connection: "connected" });
    expect(out).toBe(
      "model m-1 · session ok │ Tab focus · PgUp/PgDn scroll · Enter send · Ctrl+C quit",
    );
  });

  it("prepends the spinner as its own segment while busy", () => {
    const out = body({ busy: true, busyFrame: 0, model: "m-1", connection: "connected" });
    expect(out).toMatch(/^⠋ thinking… │ model m-1 · session ok │/);
    expect(out).not.toMatch(/·.*⠋|⠋.*·.*thinking/);
  });

  it("joins the transient note into the activity segment", () => {
    const out = body({ statusNote: "session saved — bye", model: "m-1", connection: "connected" });
    expect(out).toMatch(/^session saved — bye │ model m-1 · session ok │/);
  });

  it("reflects a non-connected state in the session segment", () => {
    const out = body({ model: "m-1", connection: "error" });
    expect(out).toMatch(/^model m-1 · error │/);
  });

  it("hints Esc abort while busy and Enter send while idle", () => {
    const busy = body({ busy: true, busyFrame: 0, model: "m-1", connection: "connected" });
    expect(busy).toContain("Esc abort");
    expect(busy).not.toContain("Enter send");
    const idle = body({ busy: false, model: "m-1", connection: "connected" });
    expect(idle).toContain("Enter send");
    expect(idle).not.toContain("Esc abort");
  });
});
