/**
 * SSE reading for the transport: frame parsing (blank-line separated
 * blocks, `event:`/`data:` fields), envelope decoding, and the read loop
 * that dispatches envelopes to a consumer.
 */
import type { TurnEnvelope } from "./wire.ts";

/** One SSE frame, split into its `event:` name and raw `data:` payload(s). */
export interface ParsedFrame {
  event: string;
  data: string;
}

/**
 * Parse one raw SSE block (text between blank lines) into its fields.
 * `data:` lines are concatenated with newlines per the SSE spec; unknown
 * fields (`id:`, `retry:`, comments) are tolerated and ignored.
 */
export function parseFrame(block: string): ParsedFrame | undefined {
  let event = "";
  const dataLines: string[] = [];
  for (const rawLine of block.split(/\r\n|\r|\n/)) {
    if (rawLine === "" || rawLine.startsWith(":")) continue;
    const colon = rawLine.indexOf(":");
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    let value = colon === -1 ? "" : rawLine.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (event === "" && dataLines.length === 0) return undefined;
  return { event, data: dataLines.join("\n") };
}

/**
 * Decode one parsed frame into an envelope, tolerating unknown event names:
 * the payload is authoritative when it is itself an envelope, otherwise the
 * SSE event name fills in the `type`.
 */
export function toEnvelope(frame: ParsedFrame): TurnEnvelope | undefined {
  let payload: unknown;
  try {
    payload = frame.data === "" ? undefined : JSON.parse(frame.data);
  } catch {
    return undefined; // malformed JSON — skip the frame, keep reading
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const obj = payload as Record<string, unknown>;
  if (typeof obj["type"] !== "string") {
    if (frame.event === "") return undefined;
    return { ...obj, type: frame.event, data: extractData(obj) };
  }
  return { ...obj, data: extractData(obj) } as TurnEnvelope;
}

/** Pull the `data` payload out of an envelope (or treat the object as one). */
export function extractData(obj: Record<string, unknown>): Record<string, unknown> {
  const inner = obj["data"];
  return inner !== null && typeof inner === "object" && !Array.isArray(inner)
    ? (inner as Record<string, unknown>)
    : obj;
}

/** Coerce anything into an Error (fetch aborts may hand us non-Errors). */
function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** The blank-line separators an SSE stream frames with. */
const FRAME_SEP = /\r\n\r\n|\n\n|\r\r/;

/** Dispatch every complete frame in `buf` to `onEvent`; returns what is
 *  left (an incomplete trailing block, carried into the next read). */
function drainFrames(
  buf: string,
  onEvent: (ev: TurnEnvelope) => void,
  decode: (block: string) => TurnEnvelope | undefined,
): string {
  let rest = buf;
  for (;;) {
    const sep = rest.search(FRAME_SEP);
    if (sep === -1) return rest;
    const match = rest.slice(sep).match(/^\r\n\r\n|^\n\n|^\r\r/);
    const sepLen = match ? match[0].length : 2;
    const block = rest.slice(0, sep);
    rest = rest.slice(sep + sepLen);
    const envelope = decode(block);
    if (envelope) onEvent(envelope);
  }
}

/** Dispatch a trailing unterminated block (the server forgot the blank
 *  line): an ignored shape returns without an event. */
function flushTail(
  buf: string,
  onEvent: (ev: TurnEnvelope) => void,
  decode: (block: string) => TurnEnvelope | undefined,
): void {
  if (buf.trim() === "") return;
  const envelope = decode(buf);
  if (envelope) onEvent(envelope);
}

/**
 * Read an SSE stream from a fetch `Response` until it ends, dispatching
 * envelopes to `onEvent`. Resolves on a clean end; resolves with the error
 * captured when the body died mid-stream (`streamError`).
 *
 * `decode` turns one raw block (the text between blank lines) into an
 * envelope, or undefined for shapes the transport ignores.
 */
export async function readSseStream(
  res: Response,
  onEvent: (ev: TurnEnvelope) => void,
  decode: (block: string) => TurnEnvelope | undefined,
): Promise<Error | undefined> {
  const body = res.body;
  if (!body) return new Error("response has no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let streamError: Error | undefined;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf = drainFrames(buf + decoder.decode(value, { stream: true }), onEvent, decode);
    }
    flushTail(buf, onEvent, decode);
  } catch (err) {
    streamError = toError(err);
  }
  return streamError;
}

/** One consumed session stream: the `stream.hello` id and the end/error. */
export interface ConsumedStream {
  readonly streamId: string | undefined;
  readonly streamError: Error | undefined;
}

/** Read the stream to its end; `stream.hello` frames carry the stream id
 *  (transport framing) and never reach `onEvent`. */
export async function consumeStream(
  res: Response,
  onEvent: (ev: TurnEnvelope) => void,
  decode: (block: string) => TurnEnvelope | undefined,
): Promise<ConsumedStream> {
  let streamId: string | undefined;
  const streamError = await readSseStream(
    res,
    (ev) => {
      if (ev.type === "stream.hello") {
        if (typeof ev.data["streamId"] === "string") streamId = ev.data["streamId"] as string;
        return; // transport framing, not a turn event
      }
      onEvent(ev);
    },
    decode,
  );
  return { streamId, streamError };
}
