import { describe, expect, it } from "vitest";
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
    expect(err.message).toContain("YOG_SERVER_URL");
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