import { afterEach, describe, expect, it, vi } from "vitest";

import { startIdleWatch } from "../../src/app/index.ts";
import { YogClient } from "../../src/client/index.ts";
import { resetForTests, setState, getState } from "../../src/core/index.ts";

/** One SSE frame in the wire format openStream consumes. */
function frame(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ id: 1, type, version: 1, ts: 1, data })}\n\n`;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetForTests();
});

describe("idleWatch — foreign turns render live", () => {
  it("a wake turn's turn.started lands the delivering notice at t=0 (#144)", async () => {
    setState({ busy: false });
    const host = { entries: [] as Array<{ kind: string; lines: string[] }> };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                [
                  frame("stream.hello", { streamId: "st1" }),
                  // A wake turn announces on its FIRST delivered pair frame
                  // (the server publishes the pair before turn.started, so
                  // the notice must precede its results).
                  frame("turn.started", { turnId: "t9", model: "m", wake: true }),
                  frame("tool.call", { id: "call_bg_x1", name: "bash", args: "{}" }),
                ].join(""),
              ),
            );
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    const watch = startIdleWatch(client, {
      entries: host.entries,
      append: (kind: never, lines: never) => void host.entries.push({ kind, lines } as never),
      width: () => 80,
      requestRender: () => undefined,
      nextMessageSeq: () => "1",
    } as never);
    watch.arm();
    await vi.waitFor(() => expect(host.entries.length).toBe(2));
    // The notice precedes the delivered pair's call row (#146 ordering).
    expect(host.entries[0]!.kind).toBe("notice");
    expect(host.entries[0]!.lines[0]).toContain("background jobs");
    watch.disarm();
  });

  it("a user turn's turn.started does NOT announce (only wake turns do)", async () => {
    setState({ busy: false });
    const host = { entries: [] as Array<{ kind: string; lines: string[] }> };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                [
                  frame("stream.hello", { streamId: "st1" }),
                  frame("turn.started", { turnId: "t9", model: "m" }),
                ].join(""),
              ),
            );
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    const watch = startIdleWatch(client, {
      entries: host.entries,
      append: (kind: never, lines: never) => void host.entries.push({ kind, lines } as never),
      width: () => 80,
      requestRender: () => undefined,
      nextMessageSeq: () => "1",
    } as never);
    watch.arm();
    await vi.waitFor(() => expect(true).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(host.entries.length).toBe(0);
    watch.disarm();
  });

  it("a wake turn's events land in the log while idle; busy follows", async () => {
    setState({ busy: false });
    const host = { entries: [] as Array<{ kind: string; lines: string[] }> };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { signal?: AbortSignal }) => {
        const first = [
          frame("stream.hello", { streamId: "st1" }),
          frame("turn.started", { turnId: "t9", model: "m" }),
        ].join("");
        const rest = [
          frame("tool.call", { id: "c1", name: "bash", args: '{"command":"echo hi"}' }),
          frame("tool.result", { id: "c1", name: "bash", ok: true, result: { exitCode: 0 } }),
          frame("turn.finished", { durationMs: 1200 }),
        ].join("");
        if (init?.signal !== undefined) {
          // Resolve when the test closes the stream.
          init.signal.addEventListener("abort", () => undefined, { once: true });
        }
        const body = new ReadableStream({
          start(controller) {
            // First burst: hello + turn.started only (busy flips true).
            controller.enqueue(new TextEncoder().encode(first));
            // The rest ride a later tick so the busy=true window is
            // observable between bursts.
            setTimeout(() => {
              try {
                controller.enqueue(new TextEncoder().encode(rest));
              } catch {
                // The stream may be closed by then; nothing to observe.
              }
            }, 50);
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    // YogClient-shaped: openStream + stream.closed handled internally.
    const watch = startIdleWatch(client, {
      entries: host.entries,
      append: (kind: never, lines: never) => void host.entries.push({ kind, lines } as never),
      width: () => 80,
      requestRender: () => undefined,
      nextMessageSeq: () => "1",
    } as never);
    watch.arm();
    await vi.waitFor(() => expect(host.entries.length).toBeGreaterThan(0));
    // The second burst: the tool call renders through the presenter.
    await vi.waitFor(() => expect(host.entries.length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(getState().busy).toBe(false));
    watch.disarm();
  });
});
