import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseFrame,
  toEnvelope,
  readSseStream,
  parseToolArgs,
  isUnreachable,
  unreachableError,
  toYogError,
  YogError,
  type TurnEnvelope,
  type TokenUsage,
  YogClient,
} from "../src/yogClient.ts";

/** Build a fetch-style Response whose body streams the given chunks. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]));
      else controller.close();
    },
  });
  return new Response(stream);
}

/**
 * Wrap a `data` payload in the messages-channel response envelope
 * (`{ type, version, data }`); pass `status: 202` for streaming types.
 */
function msgResponse(type: string, data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ type, version: 1, data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Build an SSE `data` line for a full wire envelope (the server frames
 * `{ id, type, version, ts, data }` with the event name matching `type`).
 */
function envFrame(type: string, data: Record<string, unknown>, id = 1): string {
  return `event: ${type}\ndata: ${JSON.stringify({ id, type, version: 1, ts: 1, data })}\n\n`;
}

/** The `stream.hello` frame every session stream starts with. */
function helloFrame(streamId = "stream-1"): string {
  return envFrame("stream.hello", { streamId, sessionId: "s1" }, 0);
}

/** Build a Response whose body stream throws the given error mid-read. */
function failingResponse(firstChunk: string, error: unknown): Response {
  const encoder = new TextEncoder();
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(encoder.encode(firstChunk));
      } else {
        controller.error(error);
      }
    },
  });
  return new Response(stream);
}

describe("parseFrame", () => {
  it("splits event and data fields", () => {
    expect(parseFrame('event: message.delta\ndata: {"a":1}')).toEqual({
      event: "message.delta",
      data: '{"a":1}',
    });
  });

  it("joins multiple data lines with newlines", () => {
    expect(parseFrame("data: line1\ndata: line2")).toEqual({
      event: "",
      data: "line1\nline2",
    });
  });

  it("returns undefined for an empty block", () => {
    expect(parseFrame("")).toBeUndefined();
  });

  it("returns undefined for a block with no event or data fields", () => {
    expect(parseFrame(": comment only")).toBeUndefined();
    expect(parseFrame("id: 42")).toBeUndefined();
    expect(parseFrame("retry: 100")).toBeUndefined();
  });

  it("keeps an event-only frame (empty data)", () => {
    expect(parseFrame("event: turn.started")).toEqual({
      event: "turn.started",
      data: "",
    });
  });

  it("treats a bare 'data' line as an empty data field, but a bare 'event' line as nothing", () => {
    expect(parseFrame("data")).toEqual({ event: "", data: "" });
    expect(parseFrame("event")).toBeUndefined();
  });

  it("strips only one leading space from values", () => {
    expect(parseFrame("data:  two spaces")).toEqual({
      event: "",
      data: " two spaces",
    });
  });

  it("handles CRLF and lone CR line endings", () => {
    expect(parseFrame("event: a\r\ndata: b\r\n")).toEqual({
      event: "a",
      data: "b",
    });
    expect(parseFrame("event: a\rdata: b")).toEqual({
      event: "a",
      data: "b",
    });
  });
});

describe("toEnvelope", () => {
  it("maps a full envelope payload, preserving id/version/ts", () => {
    const frame = {
      event: "message.delta",
      data: '{"id":"e1","type":"message.delta","version":"1","ts":"t","data":{"text":"hi"}}',
    };
    expect(toEnvelope(frame)).toEqual({
      id: "e1",
      type: "message.delta",
      version: "1",
      ts: "t",
      data: { text: "hi" },
    });
  });

  it("unwraps a nested data object", () => {
    expect(toEnvelope({ event: "", data: '{"type":"tool.call","data":{"id":"x"}}' })).toEqual({
      type: "tool.call",
      data: { id: "x" },
    });
  });

  it("falls back to the object itself when data is not an object", () => {
    expect(toEnvelope({ event: "", data: '{"type":"turn.finished","data":5}' })).toEqual({
      type: "turn.finished",
      data: { type: "turn.finished", data: 5 },
    });
  });

  it("uses the SSE event name when the payload has no type", () => {
    expect(toEnvelope({ event: "error", data: '{"code":"x"}' })).toEqual({
      code: "x",
      type: "error",
      data: { code: "x" },
    });
  });

  it("drops a payload with no type and no event name", () => {
    expect(toEnvelope({ event: "", data: '{"code":"x"}' })).toBeUndefined();
  });

  it("keeps unknown event names by using them as the type", () => {
    expect(toEnvelope({ event: "future.thing", data: '{"foo":1}' })).toEqual({
      foo: 1,
      type: "future.thing",
      data: { foo: 1 },
    });
  });

  it("drops a frame with an empty data payload even when an event name is present", () => {
    expect(toEnvelope({ event: "future.thing", data: "" })).toBeUndefined();
  });

  it("drops malformed JSON data", () => {
    expect(toEnvelope({ event: "message.delta", data: "{oops" })).toBeUndefined();
  });

  it("drops non-object payloads (null, array, scalars)", () => {
    expect(toEnvelope({ event: "", data: "null" })).toBeUndefined();
    expect(toEnvelope({ event: "", data: "[1,2]" })).toBeUndefined();
    expect(toEnvelope({ event: "", data: "5" })).toBeUndefined();
    expect(toEnvelope({ event: "", data: '"str"' })).toBeUndefined();
    expect(toEnvelope({ event: "", data: "true" })).toBeUndefined();
  });

  it("drops an empty data payload with no event name", () => {
    expect(toEnvelope({ event: "", data: "" })).toBeUndefined();
  });
});

describe("readSseStream", () => {
  it("dispatches complete frames and ignores comment-only frames", async () => {
    const events: TurnEnvelope[] = [];
    const res = sseResponse([
      ": keep-alive\n\n",
      'event: message.delta\ndata: {"text":"a"}\n\n',
      'event: turn.finished\ndata: {"durationMs":12}\n\n',
    ]);
    const err = await readSseStream(res, (ev) => events.push(ev));
    expect(err).toBeUndefined();
    expect(events).toEqual([
      { text: "a", type: "message.delta", data: { text: "a" } },
      { durationMs: 12, type: "turn.finished", data: { durationMs: 12 } },
    ]);
  });

  it("assembles frames split across chunk boundaries", async () => {
    const events: TurnEnvelope[] = [];
    const res = sseResponse([
      "event: mess",
      'age.delta\ndata: {"te',
      'xt":"split"}\n',
      '\nevent: turn.finished\ndata: {"durationMs":1}\n\n',
    ]);
    const err = await readSseStream(res, (ev) => events.push(ev));
    expect(err).toBeUndefined();
    expect(events).toEqual([
      { text: "split", type: "message.delta", data: { text: "split" } },
      { durationMs: 1, type: "turn.finished", data: { durationMs: 1 } },
    ]);
  });

  it("flushes a trailing frame that was never terminated by a blank line", async () => {
    const events: TurnEnvelope[] = [];
    const res = sseResponse(['event: message.delta\ndata: {"text":"tail"}']);
    const err = await readSseStream(res, (ev) => events.push(ev));
    expect(err).toBeUndefined();
    expect(events).toEqual([{ text: "tail", type: "message.delta", data: { text: "tail" } }]);
  });

  it("drops trailing whitespace-only buffers without dispatching", async () => {
    const events: TurnEnvelope[] = [];
    const res = sseResponse(["\n\n", "   \n\n"]);
    const err = await readSseStream(res, (ev) => events.push(ev));
    expect(err).toBeUndefined();
    expect(events).toEqual([]);
  });

  it("returns an error when the response has no body", async () => {
    const res = { body: null } as unknown as Response;
    const err = await readSseStream(res, () => {});
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toBe("response has no body");
  });

  it("captures a mid-stream error after dispatching earlier frames", async () => {
    const events: TurnEnvelope[] = [];
    const boom = new Error("socket reset");
    const res = failingResponse('event: message.delta\ndata: {"text":"ok"}\n\n', boom);
    const err = await readSseStream(res, (ev) => events.push(ev));
    expect(events).toEqual([{ text: "ok", type: "message.delta", data: { text: "ok" } }]);
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toBe("socket reset");
  });

  it("coerces non-Error stream failures into an Error", async () => {
    const res = failingResponse("junk", "plain string failure");
    const err = await readSseStream(res, () => {});
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toBe("plain string failure");
  });
});

describe("parseToolArgs", () => {
  it("parses a JSON object string into an object", () => {
    expect(parseToolArgs('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses a JSON array string into an array", () => {
    expect(parseToolArgs("[1,2]")).toEqual([1, 2]);
  });

  it("keeps scalar JSON strings as the original text", () => {
    expect(parseToolArgs('"hello"')).toBe('"hello"');
    expect(parseToolArgs("42")).toBe("42");
    expect(parseToolArgs("true")).toBe("true");
    expect(parseToolArgs("null")).toBe("null");
  });

  it("keeps non-JSON strings verbatim", () => {
    expect(parseToolArgs("not json {")).toBe("not json {");
  });

  it("passes through non-string values unchanged", () => {
    const obj = { a: 1 };
    expect(parseToolArgs(obj)).toBe(obj);
    expect(parseToolArgs(7)).toBe(7);
    expect(parseToolArgs(null)).toBeNull();
    expect(parseToolArgs(undefined)).toBeUndefined();
    const arr = [1];
    expect(parseToolArgs(arr)).toBe(arr);
  });
});

describe("isUnreachable", () => {
  it("flags connection-establishment codes on the error itself", () => {
    expect(isUnreachable(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }))).toBe(true);
    expect(isUnreachable(Object.assign(new Error("dns"), { code: "ENOTFOUND" }))).toBe(true);
    expect(isUnreachable(Object.assign(new Error("route"), { code: "EHOSTUNREACH" }))).toBe(true);
  });

  it("flags codes buried in a cause chain", () => {
    const inner = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    const outer = new Error("fetch failed", { cause: inner });
    expect(isUnreachable(outer)).toBe(true);
  });

  it("ignores mid-session codes like ECONNRESET", () => {
    expect(isUnreachable(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe(false);
  });

  it("rejects errors without a recognizable code", () => {
    expect(isUnreachable(new Error("boom"))).toBe(false);
    expect(isUnreachable(undefined)).toBe(false);
    expect(isUnreachable(null)).toBe(false);
    expect(isUnreachable("ECONNREFUSED")).toBe(false);
  });

  it("terminates on cyclic cause chains", () => {
    const a = Object.assign(new Error("a"), { code: "ETIMEDOUT" }) as Error & {
      cause?: unknown;
    };
    const b = Object.assign(new Error("b"), { code: "EPIPE", cause: a });
    a.cause = b;
    expect(isUnreachable(a)).toBe(false);
  });
});

describe("unreachableError", () => {
  it("includes base URL, cause detail, and the guidance text", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    const err = unreachableError("http://127.0.0.1:9999", cause);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("cannot reach yog server at http://127.0.0.1:9999");
    expect(err.message).toContain("connect ECONNREFUSED");
    expect(err.message).toContain("yog serve");
    expect(err.message).toContain("baseUrl");
    expect(err.message.startsWith("cannot reach yog server at")).toBe(true);
  });

  it("stringifies non-Error causes", () => {
    expect(unreachableError("http://x", "raw failure").message).toContain(
      "cannot reach yog server at http://x (raw failure)",
    );
    expect(unreachableError("http://x", 42).message).toContain("(42)");
  });
});

describe("toYogError", () => {
  it("decodes a structured error envelope into a YogError", async () => {
    const res = new Response(JSON.stringify({ error: { code: "bad_request", message: "nope" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
    const err = await toYogError(res, "creating session failed");
    expect(err).toBeInstanceOf(YogError);
    expect(err).toMatchObject({
      name: "YogError",
      code: "bad_request",
      message: "nope",
      status: 400,
    });
  });

  it("defaults the code to 'unknown' when the envelope omits it", async () => {
    const res = new Response(JSON.stringify({ error: { message: "no code" } }), { status: 422 });
    const err = await toYogError(res, "what");
    expect(err).toBeInstanceOf(YogError);
    expect((err as YogError).code).toBe("unknown");
    expect((err as YogError).status).toBe(422);
  });

  it("falls back to a status line for non-JSON bodies", async () => {
    const res = new Response("<html>gateway</html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    });
    const err = await toYogError(res, "capabilities request failed");
    expect(err).toBeInstanceOf(YogError);
    expect(err).toMatchObject({
      code: "http_error",
      message: "capabilities request failed: HTTP 502",
      status: 502,
    });
  });

  it("falls back when the JSON envelope has no error.message", async () => {
    const res = new Response(JSON.stringify({ error: { code: "x" } }), { status: 500 });
    const err = await toYogError(res, "running turn failed");
    expect((err as YogError).code).toBe("http_error");
    expect((err as YogError).message).toBe("running turn failed: HTTP 500");
    expect((err as YogError).status).toBe(500);
  });

  it("falls back when the JSON body is not an object envelope", async () => {
    const res = new Response(JSON.stringify({ nope: true }), { status: 404 });
    const err = await toYogError(res, "capabilities request failed");
    expect((err as YogError).code).toBe("http_error");
    expect((err as YogError).message).toBe("capabilities request failed: HTTP 404");
  });
});

/** A JSON Response with the given status. */
function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("YogClient.reopen", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adopts an existing session id on HTTP 200", async () => {
    const fetchMock = vi.fn(async () =>
      msgResponse("session.get", { session: { id: "s1", status: "open" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new YogClient("http://test");
    const adopted = await client.reopen("s1");
    expect(adopted).toBe("s1");
    expect(client.sessionId).toBe("s1");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/v1/sessions/s1/messages",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"type":"session.get"'),
      }),
    );
  });

  it("clears the id and resolves undefined on a 404 unknown_session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { code: "unknown_session", message: "nope" } }, 404)),
    );
    const client = new YogClient("http://test");
    client.sessionId = "stale";
    const adopted = await client.reopen("stale");
    expect(adopted).toBeUndefined();
    expect(client.sessionId).toBeUndefined();
  });

  it("surfaces a YogError for other non-2xx responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { code: "internal", message: "boom" } }, 500)),
    );
    const client = new YogClient("http://test");
    await expect(client.reopen("s1")).rejects.toMatchObject({
      name: "YogError",
      code: "internal",
      status: 500,
    });
  });

  it("propagates friendly unreachable errors for connection failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      }),
    );
    const client = new YogClient("http://test");
    await expect(client.reopen("s1")).rejects.toThrow(/cannot reach yog server/);
  });
});

describe("YogClient.getTranscript", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires an open or adopted session first", async () => {
    const client = new YogClient("http://test");
    await expect(client.getTranscript()).rejects.toThrow(/before open/);
  });

  it("fetches the full dump with no pagination when no params are given", async () => {
    const fetchMock = vi.fn(async () =>
      msgResponse("transcript.get", {
        session: { id: "s1", status: "dormant" },
        messages: [
          { seq: 1, role: "user", content: "q" },
          { seq: 2, role: "assistant", content: "a" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    const result = await client.getTranscript();
    expect(result).toEqual({
      sessionId: "s1",
      status: "dormant",
      messages: [
        { seq: 1, role: "user", content: "q" },
        { seq: 2, role: "assistant", content: "a" },
      ],
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://test/v1/sessions/s1/messages");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({ type: "transcript.get", data: {} });
  });

  it("sends afterSeq/limit in data when given", async () => {
    const fetchMock = vi.fn(async () =>
      msgResponse("transcript.get", { session: { id: "s1" }, messages: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    await client.getTranscript(7, 3);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      type: "transcript.get",
      data: { afterSeq: 7, limit: 3 },
    });
  });

  it("maps a 404 unknown_session to a YogError with that code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { code: "unknown_session", message: "gone" } }, 404)),
    );
    const client = new YogClient("http://test");
    client.sessionId = "stale";
    await expect(client.getTranscript()).rejects.toMatchObject({
      name: "YogError",
      code: "unknown_session",
      status: 404,
    });
  });

  it("falls back to http_error when an error body has no message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { code: "x" } }, 422)),
    );
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    const err = await client.getTranscript().catch((e: unknown) => e);
    expect((err as YogError).code).toBe("http_error");
    expect((err as YogError).message).toBe("fetching transcript failed: HTTP 422");
  });

  it("propagates friendly unreachable errors for connection failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Object.assign(new Error("dns"), { code: "ENOTFOUND" });
      }),
    );
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    await expect(client.getTranscript()).rejects.toThrow(/cannot reach yog server/);
  });

  it("parses per-turn metrics (turns) defensively", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        msgResponse("transcript.get", {
          session: { id: "s1", status: "open" },
          messages: [],
          turns: [
            {
              turnId: 1,
              status: "finished",
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
              durationMs: 1200,
            },
            { turnId: 2, usage: { total_tokens: "nope" } }, // malformed usage → dropped
            { turnId: "not-a-number", usage: { total_tokens: 9 } }, // malformed id → dropped
            null, // malformed row → dropped
          ],
        }),
      ),
    );
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    const result = await client.getTranscript();
    expect(result.turns).toEqual([
      {
        turnId: 1,
        status: "finished",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        durationMs: 1200,
      },
    ]);
  });

  it("keeps a status-only turn row (a running turn with no metrics yet)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        msgResponse("transcript.get", {
          session: { id: "s1", status: "open" },
          messages: [],
          turns: [{ turnId: 7, status: "running" }],
        }),
      ),
    );
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    const result = await client.getTranscript();
    expect(result.turns).toEqual([{ turnId: 7, status: "running" }]);
    // The reconnect pickup signal: a running turn the client can surface.
    const running = (result.turns ?? []).find((t) => t.status === "running");
    expect(running?.turnId).toBe(7);
  });
});

describe("YogClient.runTurn payload", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends turn.start with only { prompt, model } — history never rides along", async () => {
    // A clean terminal stream: stream.hello → turn.started → turn.finished.
    // The messages POST answers 202 { accepted } and the stream carries the rest.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith("/stream")) {
          return sseResponse([
            helloFrame("stream-1"),
            envFrame("turn.started", { turnId: "t1", model: "m" }),
            envFrame("turn.finished", { durationMs: 5 }),
          ]);
        }
        return msgResponse("turn.start", { accepted: true }, 202);
      }),
    );
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    const outcome = await client.runTurn("hello", "model-x", {});
    expect(outcome.ok).toBe(true);
    const fetchMock = vi.mocked(fetch);
    const msgCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).endsWith("/messages"),
    ) as unknown as [string, RequestInit];
    expect(JSON.parse(String(msgCall[1].body))).toMatchObject({
      type: "turn.start",
      data: { prompt: "hello", model: "model-x" },
    });
  });

  it("reports aborted: true and fires onAborted on a turn.aborted event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith("/stream")) {
          return sseResponse([
            helloFrame(),
            envFrame("turn.started", { turnId: "t1", model: "m" }),
            envFrame("turn.aborted", { reason: "turn aborted by operator" }),
          ]);
        }
        return msgResponse("turn.start", { accepted: true }, 202);
      }),
    );
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    const aborted: string[] = [];
    const outcome = await client.runTurn("hello", "model-x", {
      onAborted: (reason) => aborted.push(reason),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.aborted).toBe(true);
    expect(aborted).toEqual(["turn aborted by operator"]);
  });

  it("propagates stopReason from turn.finished on the direct path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith("/stream")) {
          return sseResponse([
            helloFrame(),
            envFrame("turn.started", { turnId: "t1", model: "m" }),
            envFrame("turn.finished", { durationMs: 9, stopReason: "max_rounds" }),
          ]);
        }
        return msgResponse("turn.start", { accepted: true }, 202);
      }),
    );
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    const finished: Array<{ durationMs: number; stopReason?: string }> = [];
    const outcome = await client.runTurn("hello", "model-x", {
      onFinish: (durationMs, stopReason) => finished.push({ durationMs, stopReason }),
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.stopReason).toBe("max_rounds");
    expect(finished).toEqual([{ durationMs: 9, stopReason: "max_rounds" }]);
  });

  it("recovers a terminal event when the stream ends cleanly without one", async () => {
    // A server that ends the SSE stream after turn.started without a
    // terminal event (the pre-stopReason bug): the client must not report
    // a bare "ended without a terminal event" failure when the stored turn
    // has one — it recovers from turn-status instead.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith("/stream")) {
          return sseResponse([
            helloFrame(),
            envFrame("turn.started", { turnId: "t1", model: "m" }),
            envFrame("message.delta", { text: "partial" }),
            // stream ends cleanly — no terminal event
          ]);
        }
        if (String(url).endsWith("/messages")) {
          return msgResponse("turn.get", {
            turn: {
              events: [
                { type: "turn.started", data: { turnId: "t1", model: "m" } },
                { type: "message.delta", data: { text: "partial" } },
                { type: "turn.finished", data: { durationMs: 5, stopReason: "max_rounds" } },
              ],
            },
          });
        }
        return msgResponse("turn.start", { accepted: true }, 202);
      }),
    );
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    const finished: Array<{ durationMs: number; stopReason?: string }> = [];
    const outcome = await client.runTurn("hello", "model-x", {
      onFinish: (durationMs, stopReason) => finished.push({ durationMs, stopReason }),
    });
    expect(outcome.recovered).toBe(true);
    expect(outcome.ok).toBe(true);
    expect(outcome.stopReason).toBe("max_rounds");
    expect(finished).toEqual([{ durationMs: 5, stopReason: "max_rounds" }]);
  });

  it("still reports a bare failure when recovery also has no terminal event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith("/stream")) {
          return sseResponse([
            helloFrame(),
            envFrame("turn.started", { turnId: "t1", model: "m" }),
          ]);
        }
        // Turn exists but stores no terminal event either.
        if (String(url).endsWith("/messages")) {
          return msgResponse("turn.get", {
            turn: {
              events: [{ type: "turn.started", data: { turnId: "t1", model: "m" } }],
            },
          });
        }
        return msgResponse("turn.start", { accepted: true }, 202);
      }),
    );
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    const outcome = await client.runTurn("hello", "model-x", {});
    expect(outcome.ok).toBe(false);
    expect(outcome.recovered).toBe(true);
    expect(outcome.failure).toBe("turn recovery returned no terminal event");
  });

  it("flags aborted through turn-status recovery too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith("/stream")) {
          // Stream that starts then dies mid-turn.
          return failingResponse(
            helloFrame() + envFrame("turn.started", { turnId: "t1", model: "m" }),
            new Error("reset"),
          );
        }
        // Turn-status replay: the stored terminal event is turn.aborted.
        if (String(url).endsWith("/messages")) {
          return msgResponse("turn.get", {
            turn: {
              events: [
                { type: "turn.started", data: { turnId: "t1", model: "m" } },
                { type: "turn.aborted", data: { reason: "turn aborted by operator" } },
              ],
            },
          });
        }
        return msgResponse("turn.start", { accepted: true }, 202);
      }),
    );
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    const aborted: string[] = [];
    const outcome = await client.runTurn("hello", "model-x", {
      onAborted: (reason) => aborted.push(reason),
    });
    expect(outcome.recovered).toBe(true);
    expect(outcome.aborted).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(aborted).toEqual(["turn aborted by operator"]);
  });
});

describe("YogClient token usage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses usage from turn.finished on the direct path into onFinish and the outcome", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith("/stream")) {
          return sseResponse([
            helloFrame(),
            envFrame("turn.started", { turnId: "t1", model: "m" }),
            envFrame("turn.finished", {
              durationMs: 9,
              usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
            }),
          ]);
        }
        return msgResponse("turn.start", { accepted: true }, 202);
      }),
    );
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    const finished: Array<{ durationMs: number; stopReason?: string; usage?: unknown }> = [];
    const outcome = await client.runTurn("hello", "model-x", {
      onFinish: (durationMs, stopReason, usage) => finished.push({ durationMs, stopReason, usage }),
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.usage).toEqual({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
    expect(finished).toEqual([
      {
        durationMs: 9,
        stopReason: undefined,
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      },
    ]);
  });

  it("tolerates absent or malformed usage (drops it, never throws)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith("/stream")) {
          return sseResponse([
            helloFrame(),
            envFrame("turn.started", { turnId: "t1", model: "m" }),
            envFrame("turn.finished", {
              durationMs: 9,
              usage: { prompt_tokens: "NaN", total_tokens: [1] },
            }),
          ]);
        }
        return msgResponse("turn.start", { accepted: true }, 202);
      }),
    );
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    const outcome = await client.runTurn("hello", "model-x", {});
    expect(outcome.ok).toBe(true);
    expect(outcome.usage).toBeUndefined();
  });

  it("carries usage through turn-status recovery", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith("/stream")) {
          return failingResponse(
            helloFrame() + envFrame("turn.started", { turnId: "t1", model: "m" }),
            new Error("reset"),
          );
        }
        if (String(url).endsWith("/messages")) {
          return msgResponse("turn.get", {
            turn: {
              events: [
                { type: "turn.started", data: { turnId: "t1", model: "m" } },
                {
                  type: "turn.finished",
                  data: {
                    durationMs: 9,
                    stopReason: "max_rounds",
                    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
                  },
                },
              ],
            },
          });
        }
        return msgResponse("turn.start", { accepted: true }, 202);
      }),
    );
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    const finished: Array<{ durationMs: number; stopReason?: string; usage?: unknown }> = [];
    const outcome = await client.runTurn("hello", "model-x", {
      onFinish: (durationMs, stopReason, usage) => finished.push({ durationMs, stopReason, usage }),
    });
    expect(outcome.recovered).toBe(true);
    expect(outcome.ok).toBe(true);
    expect(outcome.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    expect(finished).toEqual([
      {
        durationMs: 9,
        stopReason: "max_rounds",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ]);
  });

  it("passes round usage through tool.result on the direct path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith("/stream")) {
          return sseResponse([
            helloFrame(),
            envFrame("turn.started", { turnId: "t1", model: "m" }),
            envFrame("tool.call", { id: "c1", name: "bash", args: "{}" }),
            envFrame("tool.result", {
              id: "c1",
              name: "bash",
              ok: true,
              result: { exitCode: 0 },
              usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
              resultTokens: 362,
            }),
            envFrame("turn.finished", { durationMs: 1 }),
          ]);
        }
        return msgResponse("turn.start", { accepted: true }, 202);
      }),
    );
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    const calls: Array<{
      id: string;
      usage?: TokenUsage;
      promptDelta?: number;
      resultTokens?: number;
    }> = [];
    const toolCalls: Array<{ id: string; name: string }> = [];
    const outcome = await client.runTurn("hello", "model-x", {
      onToolCall: (id, name) => toolCalls.push({ id, name }),
      onToolResult: (id, _name, _ok, _result, _error, usage, promptDelta, resultTokens) =>
        calls.push({ id, usage, promptDelta, resultTokens }),
    });
    expect(outcome.ok).toBe(true);
    expect(calls).toEqual([
      {
        id: "c1",
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        resultTokens: 362,
      },
    ]);
    expect(toolCalls).toEqual([{ id: "c1", name: "bash" }]);
  });

  it("tolerates malformed per-call tokens (none passed through)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith("/stream")) {
          return sseResponse([
            helloFrame(),
            envFrame("turn.started", { turnId: "t1", model: "m" }),
            envFrame("tool.result", { id: "c1", name: "bash", ok: true, usage: "NaN" }),
            envFrame("turn.finished", { durationMs: 1 }),
          ]);
        }
        return msgResponse("turn.start", { accepted: true }, 202);
      }),
    );
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    const calls: Array<{ id: string; usage?: TokenUsage; promptDelta?: number }> = [];
    await client.runTurn("hello", "model-x", {
      onToolResult: (id, _name, _ok, _result, _error, usage, promptDelta) =>
        calls.push({ id, usage, promptDelta }),
    });
    expect(calls).toEqual([{ id: "c1", usage: undefined, promptDelta: undefined }]);
  });

  it("carries per-call tokens through turn-status recovery", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith("/stream")) {
          return failingResponse(
            helloFrame() + envFrame("turn.started", { turnId: "t1", model: "m" }),
            new Error("reset"),
          );
        }
        if (String(url).endsWith("/messages")) {
          return msgResponse("turn.get", {
            turn: {
              events: [
                { type: "turn.started", data: { turnId: "t1", model: "m" } },
                { type: "tool.call", data: { id: "c1", name: "bash", args: "{}" } },
                {
                  type: "tool.result",
                  data: {
                    id: "c1",
                    name: "bash",
                    ok: true,
                    usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
                  },
                },
                { type: "turn.finished", data: { durationMs: 5 } },
              ],
            },
          });
        }
        return msgResponse("turn.start", { accepted: true }, 202);
      }),
    );
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    const calls: Array<{ id: string; usage?: TokenUsage; promptDelta?: number }> = [];
    const outcome = await client.runTurn("hello", "model-x", {
      onToolResult: (id, _name, _ok, _result, _error, usage, promptDelta) =>
        calls.push({ id, usage, promptDelta }),
    });
    expect(outcome.recovered).toBe(true);
    expect(outcome.ok).toBe(true);
    expect(calls).toEqual([
      {
        id: "c1",
        usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
      },
    ]);
  });

  it("passes cut-point usage through turn.aborted on the direct path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith("/stream")) {
          return sseResponse([
            helloFrame(),
            envFrame("turn.started", { turnId: "t1", model: "m" }),
            envFrame("turn.aborted", {
              reason: "turn aborted by operator",
              usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
            }),
          ]);
        }
        return msgResponse("turn.start", { accepted: true }, 202);
      }),
    );
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    const aborted: Array<{ reason: string; usage?: TokenUsage }> = [];
    const outcome = await client.runTurn("hello", "model-x", {
      onAborted: (reason, usage) => aborted.push({ reason, usage }),
    });
    expect(outcome.aborted).toBe(true);
    expect(aborted).toEqual([
      {
        reason: "turn aborted by operator",
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      },
    ]);
  });

  it("carries cut-point usage through turn-status recovery", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith("/stream")) {
          return failingResponse(
            helloFrame() + envFrame("turn.started", { turnId: "t1", model: "m" }),
            new Error("reset"),
          );
        }
        if (String(url).endsWith("/messages")) {
          return msgResponse("turn.get", {
            turn: {
              events: [
                { type: "turn.started", data: { turnId: "t1", model: "m" } },
                {
                  type: "turn.aborted",
                  data: {
                    reason: "turn aborted by operator",
                    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
                  },
                },
              ],
            },
          });
        }
        return msgResponse("turn.start", { accepted: true }, 202);
      }),
    );
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    const aborted: Array<{ reason: string; usage?: TokenUsage }> = [];
    const outcome = await client.runTurn("hello", "model-x", {
      onAborted: (reason, usage) => aborted.push({ reason, usage }),
    });
    expect(outcome.recovered).toBe(true);
    expect(outcome.aborted).toBe(true);
    expect(aborted).toEqual([
      {
        reason: "turn aborted by operator",
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      },
    ]);
  });
});

describe("YogClient.abortTurn", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires an open or adopted session first", async () => {
    const client = new YogClient("http://test");
    await expect(client.abortTurn()).rejects.toThrow(/before open/);
  });

  it("sends turn.abort and reports an unwound turn", async () => {
    const fetchMock = vi.fn(async () =>
      msgResponse("turn.abort", {
        ok: true,
        status: "aborted",
        aborted: {
          requested: true,
          sessionId: "s1",
          activeToolCall: { id: "c1", name: "bash" },
        },
        session: { id: "s1" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    const result = await client.abortTurn();
    expect(result.requested).toBe(true);
    expect(result.status).toBe("aborted");
    expect(result.activeToolCall).toEqual({ id: "c1", name: "bash" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://test/v1/sessions/s1/messages");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({ type: "turn.abort" });
  });

  it("reports idle with no activeToolCall when nothing was running", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        msgResponse("turn.abort", {
          ok: true,
          status: "idle",
          aborted: { requested: false, sessionId: "s1", activeToolCall: null },
          session: { id: "s1" },
        }),
      ),
    );
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    const result = await client.abortTurn();
    expect(result.requested).toBe(false);
    expect(result.status).toBe("idle");
    expect(result.activeToolCall).toBeUndefined();
  });

  it("surfaces a YogError for non-2xx responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { code: "internal", message: "boom" } }, 500)),
    );
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    await expect(client.abortTurn()).rejects.toMatchObject({
      name: "YogError",
      code: "internal",
      status: 500,
    });
  });

  it("propagates friendly unreachable errors for connection failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      }),
    );
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    await expect(client.abortTurn()).rejects.toThrow(/cannot reach yog server/);
  });
});

describe("YogClient compaction/handoff", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function clientWithSession(): YogClient {
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    return client;
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("sends compaction.run (compact) and parses the result", async () => {
    const client = clientWithSession();
    const fetchMock = vi.fn(async () =>
      msgResponse("compaction.run", {
        ok: true,
        kind: "compact",
        summary: "# S",
        model: "m",
        sessionId: "fresh",
        truncated: true,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await client.compact("focus on x");
    expect(result.summary).toBe("# S");
    expect(result.model).toBe("m");
    expect(result.sessionId).toBe("fresh");
    expect(result.truncated).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("http://test/v1/sessions/s1/messages");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({
      type: "compaction.run",
      data: { kind: "compact", guidance: "focus on x" },
    });
  });

  it("POSTs /handoff and surfaces server errors", async () => {
    const client = clientWithSession();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { code: "unknown_session", message: "gone" } }, 404)),
    );
    await expect(client.handoff()).rejects.toMatchObject({ code: "unknown_session" });
  });

  it("rejects malformed success responses", async () => {
    const client = clientWithSession();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: true })),
    );
    await expect(client.compact()).rejects.toThrow(/malformed/);
  });

  it("sends an empty body when no guidance is given", async () => {
    const client = clientWithSession();
    const fetchMock = vi.fn(async () =>
      msgResponse("compaction.run", { ok: true, kind: "handoff", summary: "# H" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await client.handoff(undefined);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      type: "compaction.run",
      data: { kind: "handoff" },
    });
  });
});

describe("YogClient shake", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it("sends transcript.shake and parses truncation counts", async () => {
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    const fetchMock = vi.fn(async () =>
      msgResponse("transcript.shake", {
        ok: true,
        argsTruncated: 2,
        resultsTruncated: 1,
        contextSize: 9500,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await client.shake();
    expect(result).toEqual({ ok: true, argsTruncated: 2, resultsTruncated: 1, contextSize: 9500 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://test/v1/sessions/s1/messages");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({ type: "transcript.shake" });
  });

  it("surfaces server errors", async () => {
    const client = new YogClient("http://test");
    client.sessionId = "s1";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { code: "unknown_session", message: "gone" } }, 404)),
    );
    await expect(client.shake()).rejects.toMatchObject({ code: "unknown_session" });
  });
});
