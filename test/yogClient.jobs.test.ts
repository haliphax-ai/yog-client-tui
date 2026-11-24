import { afterEach, describe, expect, it, vi } from "vitest";

import { YogClient } from "../src/client/index.ts";

/** Wrap a `data` payload in the messages-channel response envelope. */
function msgResponse(type: string, data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ type, version: 1, data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("YogClient.getJobs", () => {
  it("sends jobs.get without a jobId and decodes the session's list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        msgResponse("jobs.get", {
          jobs: [
            {
              id: "bg_1",
              sessionId: "s1",
              tool: "bash",
              argsJson: "{\"command\":\"sleep 30\"}",
              startedAt: 1_000,
              state: "running",
            },
            { id: "bg_2", sessionId: "s1", tool: "bash", startedAt: 2_000, state: "finished" },
          ],
        }),
      ),
    );
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    const result = await client.getJobs();
    expect(result.jobs).toHaveLength(2);
    expect(result.jobs![0]!.id).toBe("bg_1");
    expect(result.jobs![0]!.tool).toBe("bash");
    expect(result.job).toBeUndefined();
    const call = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit];
    expect(String(call[0])).toContain("/v1/sessions/s1/messages");
    expect(JSON.parse(String(call[1].body))).toMatchObject({ type: "jobs.get", data: {} });
  });

  it("sends the detail probe with the named jobId", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        msgResponse("jobs.get", {
          job: { id: "bg_7", sessionId: "s1", tool: "bash", startedAt: 1, state: "terminated", termReason: "max runtime" },
        }),
      ),
    );
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    const result = await client.getJobs("bg_7");
    expect(result.jobs).toBeUndefined();
    expect(result.job?.termReason).toBe("max runtime");
    const call = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(call[1].body))).toMatchObject({ type: "jobs.get", data: { jobId: "bg_7" } });
  });

  it("drops malformed rows instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        msgResponse("jobs.get", {
          jobs: [
            { id: "bg_ok", sessionId: "s1", tool: "bash", startedAt: 1, state: "running" },
            "not-a-row",
            null,
            { broken: true },
          ],
        }),
      ),
    );
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    const result = await client.getJobs();
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs![0]!.id).toBe("bg_ok");
  });

  it("refuses to run before a session exists", async () => {
    const client = new YogClient("http://test");
    await expect(client.getJobs()).rejects.toThrow(/before open/);
  });

  it("surfaces the server's error envelope as a YogError (unknown_job, internal)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: "unknown_job", message: "job bg_x not found" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    await expect(client.getJobs("bg_x")).rejects.toMatchObject({
      code: "unknown_job",
      status: 404,
    });
  });
});
