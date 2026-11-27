import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveSession } from "../../src/app/index.ts";
import { YogClient } from "../../src/client/index.ts";

/** The messages-channel response envelope for one reply. */
function msgResponse(type: string, data: unknown): unknown {
  return new Response(JSON.stringify({ type, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveSession — running-turn pickup at resume", () => {
  it("flags a running turn from the dump (the resume 'turn in flight' pickup)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        msgResponse("transcript.get", {
          session: { id: "s-live", status: "active" },
          messages: [
            { seq: 1, role: "user", content: "q" },
            { seq: 2, role: "assistant", content: "a" },
          ],
          turns: [
            { turnId: 1, status: "finished" },
            { turnId: 2, status: "running" },
          ],
        }),
      ),
    );
    const client = new YogClient("http://test");
    const resolved = await resolveSession(client, "s-live");
    // main.ts keys the reconnect pickup off this id: the 'turn in flight'
    // notice + the poll-to-settle.
    expect(resolved.runningTurnId).toBe(2);
  });

  it("no pickup when every turn settled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        msgResponse("transcript.get", {
          session: { id: "s-idle", status: "dormant" },
          messages: [{ seq: 1, role: "user", content: "q" }],
          turns: [{ turnId: 1, status: "finished" }],
        }),
      ),
    );
    const client = new YogClient("http://test");
    const resolved = await resolveSession(client, "s-idle");
    expect(resolved.runningTurnId).toBeUndefined();
  });
});
