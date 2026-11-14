/**
 * yog HTTP/SSE client — every server interaction lives here.
 *
 * Wire contract (v1 messages/stream): the HTTP surface is four routes.
 * `GET /v1/capabilities` and `POST /v1/sessions` bootstrap; every other
 * interaction is a typed message on `POST /v1/sessions/{id}/messages`
 * (`{ type, version?, requestId?, data? }` → `{ type, version, requestId?, data }`
 * or the shared `{ error: { code, message } }`), and turn events arrive
 * on the long-lived session stream `GET /v1/sessions/{id}/stream` (SSE,
 * first frame `stream.hello` carrying the `streamId` turns can bind to).
 *
 * Flow: capabilities probe → resume-or-create session → open the session
 * stream → `turn.start` messages; the server hydrates prior context
 * itself, so a turn message carries only the new prompt, and the session
 * outlives the client: the server's `session.detach` is a detach
 * (dormant, kept), and only a server-side purge truly ends a session.
 * Disconnects are cheap by contract (yog server, disconnect policy): the
 * turn is wire-independent — quitting (or any disconnect) never aborts the
 * in-flight turn; the server keeps running it to its terminal state,
 * persists the transcript, and the next launch rehydrates the result.
 * If the session stream dies after `turn.started`, the turn is replayed
 * from `turn.get` so the turn still reaches a terminal state.
 *
 * This module deals in plain data only: it knows nothing about the terminal,
 * styling, or rendering. The UI drives it through the `TurnEvents` callbacks.
 */

import { randomUUID } from "node:crypto";

/** Envelope version this client speaks (omitted on the wire means 1). */
export const MESSAGE_VERSION = 1;

/** Message `type`s the client sends on the messages channel. */
export const MESSAGE_TYPES = [
  "session.get",
  "session.detach",
  "transcript.get",
  "turn.get",
  "turn.abort",
  "turn.start",
  "compaction.run",
  "transcript.shake",
  "skills.list",
  "skills.load",
  "skills.unload",
  "skills.status",
] as const;

/** One message `type` the client can send. */
export type MessageType = (typeof MESSAGE_TYPES)[number];

/** One server-advertised slash command (mirrors the daemon wire shape). */
export interface ServerCommandDescriptor {
  readonly name: string;
  readonly summary: string;
  readonly args?: string;
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly argField?: string;
  readonly requiresIdle?: boolean;
}

/** Client → server envelope (`data` carries the per-type payload). */
export interface MessageEnvelope {
  type: MessageType | (string & {});
  version?: number;
  requestId?: string;
  data?: Record<string, unknown>;
}

/** Server → client envelope (`data` carries the per-type payload). */
export interface MessageResponse {
  type: string;
  version?: number;
  requestId?: string;
  data: Record<string, unknown>;
}

/** Advertised server capabilities. */
export interface Capabilities {
  contractVersion: string;
  models: string[];
  tools: string[];
  features: string[];
  /** Message `type`s the server dispatches on the messages channel. */
  messageTypes?: string[];
  /** Slash commands the server advertises for clients to surface. */
  commands?: ServerCommandDescriptor[];
  /** Context window sizes for advertised models, keyed by model id. */
  contextWindowSizes?: Record<string, number>;
}

/** One canonical transcript row, verbatim from the wire (§5.1 of PLAN.md).
 *  `role` is "user" | "assistant" | "system" | "tool"; the optional payload
 *  fields carry tool-call data: an assistant row's `toolCalls` array
 *  (`{ id, type, function: { name, arguments } }`, arguments as a JSON
 *  string) and a tool result row's `toolCallId`. */
export interface TranscriptMessage {
  seq: number;
  turnId?: string;
  /** Row creation time (epoch milliseconds) when the server stamps one. */
  ts?: number;
  role: string;
  content?: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: unknown;
  /** The round's real provider usage (round attribution, not per-call). */
  usage?: TokenUsage;
  /** Context growth this round's call+result added (prompt_tokens diff). */
  promptDelta?: number;
  /** Estimated tokens this result adds to context (tokenx estimate). */
  resultTokens?: number;
}

/** Result of the transcript rehydration dump: the session plus its ordered
 *  rows (conversation order, monotonic per-session `seq`). */
export interface TranscriptResult {
  sessionId: string;
  status: string;
  messages: TranscriptMessage[];
  /** Per-turn metrics (usage/duration + settle status) when the server
   *  captured them. `status: "running"` marks an in-flight (typically
   *  in-flight) turn — the reconnect-detection signal. */
  turns?: Array<{
    turnId: number;
    status?: string;
    usage?: TokenUsage;
    durationMs?: number;
  }>;
}

/** Well-known event types on the turn stream. */
export type TurnEventType =
  | "stream.hello"
  | "turn.started"
  | "message.delta"
  | "tool.call"
  | "tool.result"
  | "turn.finished"
  | "turn.aborted"
  | "rate_limited"
  | "error";

/** One wire envelope: `{ id, type, version, ts, data }`. */
export interface TurnEnvelope {
  id?: string;
  type: string;
  version?: string;
  ts?: string;
  data: Record<string, unknown>;
}

/**
 * Handle for the long-lived session stream (`GET /v1/sessions/{id}/stream`).
 * `streamId` is the `stream.hello` id (undefined until the hello lands).
 * `closed` resolves when the stream ends or errors; the turn loop reads it
 * to decide between a clean terminal and `turn.get` recovery.
 */
export interface SessionStream {
  /** Server-assigned stream id from `stream.hello`, once known. */
  readonly streamId: string | undefined;
  /** Resolves with the stream failure (undefined on a clean end). */
  readonly closed: Promise<Error | undefined>;
  /** Detach the stream (aborts its fetch; the server treats it as a hang-up). */
  close(): void;
}

/** Build the envelope for one message. */
export function buildEnvelope(
  type: MessageType | (string & {}),
  data: Record<string, unknown> = {},
  requestId?: string,
): MessageEnvelope {
  return {
    type,
    version: MESSAGE_VERSION,
    ...(requestId !== undefined ? { requestId } : {}),
    data,
  };
}

/** Callbacks the UI registers for one in-flight turn. */
export interface TurnEvents {
  /** `turn.started` — the stream is live; `turnId` enables recovery. */
  onStarted?(turnId: string, model: string): void;
  /** `message.delta` — an assistant text chunk. */
  onDelta?(text: string): void;
  /** `tool.call` — the model invoked a tool. */
  onToolCall?(id: string, name: string, args: unknown): void;
  /** `tool.result` — a tool outcome. */
  onToolResult?(
    id: string,
    name: string,
    ok: boolean,
    result: unknown,
    error?: string,
    usage?: TokenUsage,
    promptDelta?: number,
    resultTokens?: number,
  ): void;
  /** `turn.finished` — normal end, or a server-capped stop (`stopReason`). */
  onFinish?(durationMs: number, stopReason?: string, usage?: TokenUsage): void;
  /** Non-terminal `rate_limited` backoff signal — the engine is waiting `delayMs` before retrying the same request. */
  onRateLimited?(info: { attempt: number; maxAttempts: number; delayMs: number }): void;
  /** `turn.aborted` — the operator aborted the turn (terminal). */
  onAborted?(reason: string, usage?: TokenUsage): void;
  /** `error` — terminal failure reported by the server. */
  onError?(code: string, message: string): void;
  /** The SSE stream died and the turn was replayed from turn-status. */
  onRecovered?(): void;
}

/**
 * Token usage reported by the model for a finished turn — mirrors the server's
 * `usage` shape (OpenAI-compatible). All fields optional: providers may omit
 * some, and the client drops malformed/non-numeric values while parsing.
 */
export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** Outcome of one `runTurn` call. */
export interface TurnOutcome {
  /** True when `turn.finished` was observed (directly or via recovery). */
  ok: boolean;
  /** Terminal failure message from an `error` envelope, if any. */
  error?: string;
  /** True when `turn.aborted` was observed (the turn was aborted). */
  aborted: boolean;
  /** Set when the stream died and turn-status recovery was used. */
  recovered: boolean;
  /**
   * The `stopReason` from the terminal `turn.finished` (e.g. `max_rounds`),
   * when the server reported one. Present on both the direct and the
   * recovered path.
   */
  stopReason?: string;
  /**
   * Terms used for 429 backoffs in this turn, when the server reported any (`rateLimitRetries` on the terminal `turn.finished`, or the per-`rate_limited` count on the recovery path). Absent on old servers that never rate-limit.
   */
  rateLimitRetries?: number;
  /** Token usage reported for the turn, when the server sent any. */
  usage?: TokenUsage;
  /** Human-readable failure when the transport itself broke. */
  failure?: string;
}

export interface ActiveToolCall {
  id: string;
  name: string;
}

/** Result of `abortTurn`: whether a live turn was unwound, and what it was
 *  doing. `requested` is false when the session had nothing to abort — the
 *  endpoint is idempotent and still answers `ok`. */
export interface AbortTurnResult {
  /** True when a live turn was found and aborted. */
  requested: boolean;
  /** Server-reported status: "aborted" when a turn was unwound, "idle" otherwise. */
  status: "aborted" | "idle";
  /** The tool call that was killed, if one was in flight. */
  activeToolCall?: ActiveToolCall;
}

/** Structured error decoded from a `{ error: { code, message } }` body. */
export class YogError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "YogError";
    this.code = code;
    this.status = status;
  }
}

/** Build the bearer header when `YOG_API_TOKEN` is set. */
function authHeaders(): Record<string, string> | undefined {
  const token = process.env["YOG_API_TOKEN"];
  return token ? { authorization: `Bearer ${token}` } : undefined;
}

/** Decode a non-2xx JSON error envelope into a `YogError`. */
export async function toYogError(res: Response, what: string): Promise<Error> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    if (body?.error?.message) {
      return new YogError(body.error.code ?? "unknown", body.error.message, res.status);
    }
  } catch {
    /* non-JSON body; fall through to the status line */
  }
  return new YogError("http_error", `${what}: HTTP ${res.status}`, res.status);
}

/**
 * Walk a `fetch` failure chain looking for connection-establishment codes.
 * A server that dies *mid-session* (reset after connect) is not "never
 * started", so only ECONNREFUSED & friends count as unreachable.
 */
export function isUnreachable(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur !== undefined && cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const code = (cur as { code?: unknown }).code;
    if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** Friendly guidance when the daemon cannot be reached (it is never spawned). */
export function unreachableError(base: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `cannot reach yog server at ${base} (${detail}); ` +
      "start it first with `yog serve` (no server is spawned automatically) " +
      "and point the client's `baseUrl` at the running daemon",
  );
}

/** One SSE frame, split into its `event:` name and raw `data:` payload(s). */
interface ParsedFrame {
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
function extractData(obj: Record<string, unknown>): Record<string, unknown> {
  const inner = obj["data"];
  return inner !== null && typeof inner === "object" && !Array.isArray(inner)
    ? (inner as Record<string, unknown>)
    : obj;
}

/** Coerce anything into an Error (fetch aborts may hand us non-Errors). */
function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Read an SSE stream from a fetch `Response` until it ends, dispatching
 * envelopes to `onEvent`. Resolves on a clean end; resolves with the error
 * captured when the body died mid-stream (`streamError`).
 */
export async function readSseStream(
  res: Response,
  onEvent: (ev: TurnEnvelope) => void,
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
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.search(/\r\n\r\n|\n\n|\r\r/)) !== -1) {
        const match = buf.slice(sep).match(/^\r\n\r\n|^\n\n|^\r\r/);
        const sepLen = match ? match[0].length : 2;
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + sepLen);
        const frame = parseFrame(block);
        if (!frame) continue;
        const envelope = toEnvelope(frame);
        if (envelope) onEvent(envelope);
      }
    }
    // Flush a trailing frame the server forgot to terminate with a blank line.
    if (buf.trim() !== "") {
      const envelope = toEnvelope(parseFrame(buf) ?? { event: "", data: buf });
      if (envelope) onEvent(envelope);
    }
  } catch (err) {
    streamError = toError(err);
  }
  return streamError;
}

/** The yog contract client. One instance per session. */
export class YogClient {
  /** Server origin, trailing slashes stripped. */
  readonly baseUrl: string;
  /** Session id once `open()` has succeeded. */
  sessionId: string | undefined;
  /** Capabilities from the startup probe. */
  capabilities: Capabilities | undefined;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  /** Auth headers for every request (bearer token when configured). */
  private headers(extra?: Record<string, string>): Record<string, string> {
    return { ...authHeaders(), ...extra };
  }
  /**
   * One typed message on the messages channel. Generates a `requestId`
   * (correlation + idempotent-retry handle) unless the caller supplies one,
   * and unwraps the `{ type, version, requestId?, data }` response to its
   * `data`. Non-2xx surfaces as a `YogError` (`unknown_session` included).
   */
  private async send(
    sessionId: string,
    type: MessageType | (string & {}),
    data: Record<string, unknown> = {},
    what = `${type} failed`,
  ): Promise<Record<string, unknown>> {
    const requestId = randomUUID();
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify(buildEnvelope(type, data, requestId)),
      });
    } catch (err) {
      throw isUnreachable(err) ? unreachableError(this.baseUrl, err) : toError(err);
    }
    if (!res.ok) throw await toYogError(res, what);
    const body = (await res.json()) as MessageResponse;
    return body.data ?? {};
  }

  /**
   * Open the long-lived session stream (`GET /v1/sessions/{id}/stream`).
   * The first frame is `stream.hello` (`data.streamId`); every envelope
   * after it is fanned out to `onEvent` (including any running-turn replay
   * the server sends before live events). The returned handle resolves
   * `closed` when the stream ends or errors — the turn loop awaits it in
   * parallel with the `turn.start` message, so a turn never blocks on a
   * held-open stream. `close()` detaches the stream (the server treats
   * the hang-up as a disconnect; lingered turns keep running).
   */
  openStream(sessionId: string, onEvent: (ev: TurnEnvelope) => void): SessionStream {
    const controller = new AbortController();
    let streamId: string | undefined;
    let settle: (err: Error | undefined) => void = () => {};
    const closed = new Promise<Error | undefined>((resolve) => {
      settle = resolve;
    });
    void (async (): Promise<void> => {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/v1/sessions/${sessionId}/stream`, {
          headers: this.headers(),
          signal: controller.signal,
        });
      } catch (err) {
        settle(isUnreachable(err) ? unreachableError(this.baseUrl, err) : toError(err));
        return;
      }
      if (!res.ok) {
        settle(await toYogError(res, "opening session stream failed"));
        return;
      }
      const streamError = await readSseStream(res, (ev) => {
        if (ev.type === "stream.hello") {
          if (typeof ev.data["streamId"] === "string") streamId = ev.data["streamId"] as string;
          return; // transport framing, not a turn event
        }
        onEvent(ev);
      });
      settle(streamError);
    })();
    return {
      get streamId() {
        return streamId;
      },
      closed,
      close: () => controller.abort(),
    };
  }

  /**
   * Probe `GET /v1/capabilities?model={model}` to establish reachability with
   * a friendly error before any session exists. The model names the session
   * model so the server can resolve its context window. Stores the result on
   * `capabilities`.
   */
  async probe(model?: string): Promise<Capabilities> {
    let res: Response;
    try {
      const qs =
        typeof model === "string" && model !== "" ? `?model=${encodeURIComponent(model)}` : "";
      res = await fetch(`${this.baseUrl}/v1/capabilities${qs}`, { headers: this.headers() });
    } catch (err) {
      throw isUnreachable(err) ? unreachableError(this.baseUrl, err) : toError(err);
    }
    if (!res.ok) throw await toYogError(res, "capabilities request failed");
    const body = (await res.json()) as Capabilities;
    this.capabilities = body;
    return body;
  }

  /** Create a session (`POST /v1/sessions`) and remember its id. */
  async open(): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/sessions`, {
        method: "POST",
        headers: this.headers(),
      });
    } catch (err) {
      throw isUnreachable(err) ? unreachableError(this.baseUrl, err) : toError(err);
    }
    if (!res.ok) throw await toYogError(res, "creating session failed");
    const created = (await res.json()) as { session?: { id?: string } };
    const id = created?.session?.id;
    if (!id || typeof id !== "string") {
      throw new Error("creating session failed: response has no session id");
    }
    this.sessionId = id;
    return id;
  }

  /**
   * Adopt an existing session after a cheap validity check (§5.2 of
   * PLAN.md): `session.get` — a reply adopts the id, `unknown_session`
   * (404) clears it and resolves `undefined` so the caller falls back to
   * `open()`. Dormancy is not an obstacle: reviving is implicit in the
   * next turn and reads work on dormant sessions. Reusing the id *is* the
   * reopen — the server keeps the transcript.
   */
  async reopen(sessionId: string): Promise<string | undefined> {
    try {
      await this.send(sessionId, "session.get", {}, "session reopen check failed");
    } catch (err) {
      if (err instanceof YogError && err.status === 404) {
        this.sessionId = undefined;
        return undefined;
      }
      throw err;
    }
    this.sessionId = sessionId;
    return sessionId;
  }

  /**
   * Transcript rehydration dump: `transcript.get` with optional
   * `afterSeq` / `limit` pagination (the TUI fetches the full dump; the
   * params exist for future use). `unknown_session` (404) surfaces as a
   * `YogError` so the caller can distinguish a stale id from a transport
   * failure. Works on dormant sessions — dormancy never blocks reads.
   */
  async getTranscript(after?: number, limit?: number): Promise<TranscriptResult> {
    if (!this.sessionId) throw new Error("getTranscript called before open() or reopen()");
    const sessionId = this.sessionId;
    const data: Record<string, unknown> = {
      ...(after !== undefined ? { afterSeq: after } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
    const body = (await this.send(
      sessionId,
      "transcript.get",
      data,
      "fetching transcript failed",
    )) as {
      session?: { id?: unknown; status?: unknown };
      messages?: unknown;
      turns?: unknown;
    };
    const id = typeof body.session?.id === "string" ? body.session.id : sessionId;
    const status = typeof body.session?.status === "string" ? body.session.status : "open";
    const rows = Array.isArray(body.messages) ? body.messages : [];
    // Per-turn metrics are additive and optional; tolerate absent/malformed
    // entries so old servers and odd payloads degrade gracefully. A row is
    // kept when it has metrics OR a settle status — the status alone is
    // meaningful (`running` = an active turn the reconnecting client should
    // surface, even with no usage/duration yet).
    const turns = (Array.isArray(body.turns) ? body.turns : [])
      .map(
        (
          t,
        ):
          | { turnId: number; status?: string; usage?: TokenUsage; durationMs?: number }
          | undefined => {
          if (t === null || typeof t !== "object" || Array.isArray(t)) return undefined;
          const rec = t as Record<string, unknown>;
          const turnId = typeof rec["turnId"] === "number" ? rec["turnId"] : undefined;
          if (turnId === undefined) return undefined;
          const usage = parseUsage(rec["usage"]);
          const durationMs =
            typeof rec["durationMs"] === "number" && Number.isFinite(rec["durationMs"])
              ? (rec["durationMs"] as number)
              : undefined;
          const status =
            typeof rec["status"] === "string" && rec["status"] !== ""
              ? (rec["status"] as string)
              : undefined;
          return {
            turnId,
            ...(status !== undefined ? { status } : {}),
            ...(usage !== undefined ? { usage } : {}),
            ...(durationMs !== undefined ? { durationMs } : {}),
          };
        },
      )
      .filter(
        (t): t is { turnId: number; status?: string; usage?: TokenUsage; durationMs?: number } =>
          t !== undefined &&
          (t.usage !== undefined || t.durationMs !== undefined || t.status !== undefined),
      );
    return {
      sessionId: id,
      status,
      messages: rows as TranscriptMessage[],
      ...(turns.length > 0 ? { turns } : {}),
    };
  }

  /**
   * Run one turn: open the long-lived session stream, POST `turn.start` on
   * the messages channel (nested under `data`, prompt-only — history never
   * rides along), and dispatch the stream's envelopes to `events`. The
   * messages POST returns `202 { accepted }` at once; the turn itself runs
   * server-side and frames its events on the stream, so this method never
   * blocks on a held-open response. The turn is wire-independent (yog
   * contract, disconnect policy): when this process goes away mid-turn —
   * quitting the TUI, a crash, a lost connection — the server keeps the
   * turn running to its terminal state instead of aborting it, and the
   * transcript persists for the next launch. When the session stream dies
   * after `turn.started`, the stored turn is replayed from `turn.get` so
   * the turn still reaches a terminal state.
   */
  async runTurn(prompt: string, model: string, events: TurnEvents): Promise<TurnOutcome> {
    if (!this.sessionId) throw new Error("runTurn called before open()");
    const sessionId = this.sessionId;
    let usage: TokenUsage | undefined;
    let turnId: string | undefined;
    let sawFinished = false;
    let sawAborted = false;
    let stopReason: string | undefined;
    let serverError: string | undefined;
    let rateLimitRetries = 0;

    // The session stream is LONG-LIVED: it stays open (with periodic
    // heartbeats) past the turn's terminal event. Settling `runTurn` must
    // therefore race the stream's death against the arrival of a terminal
    // event — awaiting the closed stream alone would hang forever once
    // `turn.finished`/`turn.aborted`/`error` has already landed (which
    // is what left the UI spinner spinning after a successful turn).
    let resolveTerminal: () => void = () => {};
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });

    /** Apply one envelope to the callbacks; used by stream and recovery. */
    const handle = (ev: TurnEnvelope): void => {
      const data = ev.data ?? {};
      switch (ev.type) {
        case "turn.started": {
          turnId = typeof data["turnId"] === "string" ? data["turnId"] : turnId;
          events.onStarted?.(
            turnId ?? "",
            typeof data["model"] === "string" ? data["model"] : model,
          );
          return;
        }
        case "message.delta": {
          if (typeof data["text"] === "string") events.onDelta?.(data["text"]);
          return;
        }
        case "tool.call": {
          events.onToolCall?.(str(data["id"]), str(data["name"]), parseToolArgs(data["args"]));
          return;
        }
        case "tool.result": {
          events.onToolResult?.(
            str(data["id"]),
            str(data["name"]),
            data["ok"] === true,
            data["result"],
            str(data["error"]) || undefined,
            parseUsage(data["usage"]),
            typeof data["promptDelta"] === "number" && Number.isFinite(data["promptDelta"])
              ? Math.max(0, data["promptDelta"])
              : undefined,
            typeof data["resultTokens"] === "number" &&
              Number.isFinite(data["resultTokens"]) &&
              (data["resultTokens"] as number) > 0
              ? data["resultTokens"]
              : undefined,
          );
          return;
        }
        case "rate_limited": {
          const delayMs = typeof data["delayMs"] === "number" ? data["delayMs"] : 0;
          const attempt =
            typeof data["attempt"] === "number" ? data["attempt"] : rateLimitRetries + 1;
          const maxAttempts = typeof data["maxAttempts"] === "number" ? data["maxAttempts"] : 0;
          rateLimitRetries += 1;
          events.onRateLimited?.({ attempt, maxAttempts, delayMs });
          return;
        }
        case "turn.finished": {
          sawFinished = true;
          // A stopReason (e.g. "max_rounds") means the server stopped the
          // turn early — surfaced on the outcome and to the UI.
          if (typeof data["stopReason"] === "string" && data["stopReason"] !== "") {
            stopReason = data["stopReason"];
          }
          const parsedRetries =
            typeof data["rateLimitRetries"] === "number" ? data["rateLimitRetries"] : undefined;
          if (parsedRetries !== undefined) rateLimitRetries = parsedRetries;
          const parsedUsage = parseUsage(data["usage"]);
          if (parsedUsage !== undefined) usage = parsedUsage;
          events.onFinish?.(
            typeof data["durationMs"] === "number" ? data["durationMs"] : 0,
            stopReason,
            usage,
          );
          resolveTerminal();
          return;
        }
        case "turn.aborted": {
          sawAborted = true;
          events.onAborted?.(str(data["reason"]) || "turn aborted", parseUsage(data["usage"]));
          resolveTerminal();
          return;
        }
        case "error": {
          serverError = str(data["message"]) || "unknown error";
          events.onError?.(str(data["code"]) || "error", serverError);
          resolveTerminal();
          return;
        }
        default:
          return; // unknown events are tolerated (forward compatibility)
      }
    };

    // The session stream is a client-owned, long-lived channel: open it once,
    // then `turn.start` on the messages channel. Events dispatched before
    // the `turn.start` reply lands are buffered by openStream's queue.
    const stream = this.openStream(sessionId, handle);
    const streamDone = stream.closed.then((err) => err);
    // `turn.start` is the only such message this client sends; its 202 is
    // semantics; its 202 is an acceptance, not the turn's progress.
    await this.send(
      sessionId,
      "turn.start",
      {
        prompt,
        model,
        ...(stream.streamId !== undefined ? { streamId: stream.streamId } : {}),
      },
      "running turn failed",
    );
    // Wait for the turn's terminal event on the stream, or for the stream
    // itself to die — whichever comes first. `readSseStream` resolves on a
    // clean end with `undefined`, so a stream that ends after the terminal
    // event is indistinguishable from one that ends before it; the flags
    // above (checked after `streamDone` settles) decide which it was.
    const [streamError, terminalWon] = await Promise.race([
      streamDone.then((err) => [err, false] as const),
      terminal.then(() => [undefined, true] as const),
    ]);
    stream.close();

    if (!terminalWon && streamError !== undefined) {
      // The stream died mid-turn: replay the stored turn events.
      if (turnId === undefined) {
        return {
          ok: false,
          recovered: false,
          aborted: false,
          error: serverError,
          failure: `turn stream interrupted (${streamError.message}) before a turnId was announced`,
        };
      }
      const recovered = await this.recoverTurn(sessionId, turnId, handle);
      events.onRecovered?.();
      return {
        ok: recovered && sawFinished && serverError === undefined,
        recovered: true,
        aborted: sawAborted,
        ...(serverError !== undefined ? { error: serverError } : {}),
        ...(recovered && sawFinished && stopReason !== undefined ? { stopReason } : {}),
        ...(recovered && sawFinished && usage !== undefined ? { usage } : {}),
        ...(rateLimitRetries > 0 ? { rateLimitRetries } : {}),
        ...(recovered ? {} : { failure: "turn-status recovery failed" }),
      };
    }

    if (serverError !== undefined)
      return { ok: false, recovered: false, error: serverError, aborted: false };
    if (sawAborted) return { ok: false, recovered: false, aborted: true };
    if (!sawFinished) {
      // Stream ended cleanly with no terminal event: a streamError would
      // have taken the recovery path above, so the server ended the stream
      // taken the recovery path above, so this is a server-side gap (an
      // older server that silently drops the turn). Recover the stored turn
      // when its id is known — the events are persisted server-side — and
      // only report a bare failure when recovery is impossible or empty.
      if (turnId !== undefined) {
        const recovered = await this.recoverTurn(sessionId, turnId, handle);
        if (recovered) {
          if (!sawFinished && !sawAborted && serverError === undefined) {
            return {
              ok: false,
              recovered: true,
              aborted: false,
              failure: "turn recovery returned no terminal event",
            };
          }
          return {
            ok: sawFinished && serverError === undefined,
            recovered: true,
            aborted: sawAborted,
            ...(serverError !== undefined ? { error: serverError } : {}),
            ...(sawFinished && stopReason !== undefined ? { stopReason } : {}),
            ...(sawFinished && usage !== undefined ? { usage } : {}),
            ...(rateLimitRetries > 0 ? { rateLimitRetries } : {}),
          };
        }
      }
      return {
        ok: false,
        recovered: false,
        failure: "turn stream ended without a terminal event",
        aborted: false,
      };
    }
    return {
      ok: true,
      recovered: false,
      aborted: false,
      ...(stopReason !== undefined ? { stopReason } : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(rateLimitRetries > 0 ? { rateLimitRetries } : {}),
    };
  }

  /**
   * Abort the session's current turn (`turn.abort` message): the server
   * kills the tool call in flight, closes the model stream, heals the
   * transcript, and settles the turn. Idempotent — an idle session answers
   * `ok` with `requested: false` and nothing is touched.
   */
  async abortTurn(): Promise<AbortTurnResult> {
    if (!this.sessionId) throw new Error("abortTurn called before open()");
    const sessionId = this.sessionId;
    const body = await this.send(sessionId, "turn.abort", {}, "aborting turn failed");
    const requested =
      body["aborted"] !== null && typeof body["aborted"] === "object"
        ? (body["aborted"] as Record<string, unknown>)["requested"] === true
        : false;
    const call = (body["aborted"] as Record<string, unknown> | undefined)?.["activeToolCall"];
    const activeToolCall =
      call !== null && typeof call === "object" && !Array.isArray(call)
        ? {
            id: str((call as Record<string, unknown>)["id"]),
            name: str((call as Record<string, unknown>)["name"]),
          }
        : undefined;
    return {
      requested,
      status: requested ? "aborted" : "idle",
      ...(activeToolCall !== undefined ? { activeToolCall } : {}),
    };
  }

  /**
   * Send one server-advertised command on the messages channel. `main.ts`
   * builds the payload from a `CommandDescriptor` (`data` + `argField`
   * remainder); the transport itself stays descriptor-agnostic — the server
   * validates the type and payload.
   */
  async sendCommand(
    type: string,
    data: Record<string, unknown> = {},
    what = `${type} failed`,
  ): Promise<Record<string, unknown>> {
    if (!this.sessionId) throw new Error(`sendCommand called before open(): ${type}`);
    const sessionId = this.sessionId;
    return await this.send(sessionId, type, data, what);
  }

  /**
   * Recovery path: `turn.get` and replay its stored `{ type, data }` rows
   * through the same handler.
   */
  private async recoverTurn(
    sessionId: string,
    turnId: string,
    handle: (ev: TurnEnvelope) => void,
  ): Promise<boolean> {
    try {
      const body = await this.send(sessionId, "turn.get", { turnId }, "recovering turn failed");
      const turn = body["turn"] as { events?: { type?: unknown; data?: unknown }[] } | undefined;
      for (const row of turn?.events ?? []) {
        if (typeof row.type !== "string") continue;
        handle({
          type: row.type,
          data:
            row.data !== null && typeof row.data === "object" && !Array.isArray(row.data)
              ? (row.data as Record<string, unknown>)
              : {},
        });
      }
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Decode `tool.call.args`: the wire carries it as a raw JSON string, so
 * parse it into a value the UI can render properly (a string that parses to
 * an object/array is unwrapped; anything else passes through as the original
 * string so the UI can pretty-print or show it verbatim).
 */
export function parseToolArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") return parsed;
    return raw; // scalar JSON: keep the original text for display
  } catch {
    return raw; // not JSON: show the raw string
  }
}

/** Read a string field from an event payload ("" when absent/not a string). */
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Extract a `TokenUsage` from a `turn.finished` payload field, tolerating
 * absent/malformed values: only numeric (finite) fields are copied, and the
 * result is `undefined` when none of them are present — callers then treat
 * the turn as having no usage (never throw).
 */
function parseUsage(value: unknown): TokenUsage | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  const out: TokenUsage = {};
  let hasNumber = false;
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"] as const) {
    const n = rec[key];
    if (typeof n === "number" && Number.isFinite(n)) {
      out[key] = n;
      hasNumber = true;
    }
  }
  return hasNumber ? out : undefined;
}
