/**
 * yog HTTP/SSE client — every server interaction lives here.
 *
 * Flow: capabilities probe → resume-or-create session → prompt-only turns
 * (SSE) → transcript rehydration. The server owns the canonical transcript
 * and hydrates prior context itself, so a turn request carries only the new
 * prompt, and the session outlives the client: the server's DELETE is a
 * detach (dormant, kept), and only a server-side purge truly ends a session.
 * If the SSE stream dies after `turn.started`, the turn is replayed from the
 * turn-status endpoint so the turn still reaches a terminal state.
 *
 * This module deals in plain data only: it knows nothing about the terminal,
 * styling, or rendering. The UI drives it through the `TurnEvents` callbacks.
 */

/** Advertised server capabilities. */
export interface Capabilities {
  contractVersion: string;
  models: string[];
  tools: string[];
  features: string[];
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
}

/** Result of the transcript rehydration dump: the session plus its ordered
 *  rows (conversation order, monotonic per-session `seq`). */
export interface TranscriptResult {
  sessionId: string;
  status: string;
  messages: TranscriptMessage[];
}

/** Well-known event types on the turn stream. */
export type TurnEventType =
  | "turn.started"
  | "message.delta"
  | "tool.call"
  | "tool.result"
  | "turn.finished"
  | "turn.aborted"
  | "error";

/** One wire envelope: `{ id, type, version, ts, data }`. */
export interface TurnEnvelope {
  id?: string;
  type: string;
  version?: string;
  ts?: string;
  data: Record<string, unknown>;
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
  onToolResult?(id: string, name: string, ok: boolean, result: unknown, error?: string): void;
  /** `turn.finished` — normal end. */
  onFinish?(durationMs: number): void;
  /** `turn.aborted` — the operator aborted the turn (terminal). */
  onAborted?(reason: string): void;
  /** `error` — terminal failure reported by the server. */
  onError?(code: string, message: string): void;
  /** The SSE stream died and the turn was replayed from turn-status. */
  onRecovered?(): void;
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
      "or point YOG_SERVER_URL at a running daemon",
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
   * Probe `GET /v1/capabilities` to establish reachability with a friendly
   * error before any session exists. Stores the result on `capabilities`.
   */
  async probe(): Promise<Capabilities> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/capabilities`, { headers: this.headers() });
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
   * PLAN.md): `GET /v1/sessions/{id}` — 200 adopts the id, 404 clears it
   * and resolves `undefined` so the caller falls back to `open()`.
   * Dormancy is not an obstacle: reviving is implicit in the next turn and
   * reads work on dormant sessions. Reusing the id *is* the reopen — the
   * server keeps the transcript.
   */
  async reopen(sessionId: string): Promise<string | undefined> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/sessions/${sessionId}`, {
        headers: this.headers(),
      });
    } catch (err) {
      throw isUnreachable(err) ? unreachableError(this.baseUrl, err) : toError(err);
    }
    if (res.status === 404) {
      this.sessionId = undefined;
      return undefined;
    }
    if (!res.ok) throw await toYogError(res, "session reopen check failed");
    this.sessionId = sessionId;
    return sessionId;
  }

  /**
   * Transcript rehydration dump: `GET /v1/sessions/{id}/transcript` with
   * optional `after` / `limit` pagination (the TUI fetches the full dump;
   * the params exist for future use). `unknown_session` (404) surfaces as a
   * `YogError` so the caller can distinguish a stale id from a transport
   * failure. Works on dormant sessions — dormancy never blocks reads.
   */
  async getTranscript(after?: number, limit?: number): Promise<TranscriptResult> {
    if (!this.sessionId) throw new Error("getTranscript called before open() or reopen()");
    const sessionId = this.sessionId;
    const params = new URLSearchParams();
    if (after !== undefined) params.set("after", String(after));
    if (limit !== undefined) params.set("limit", String(limit));
    const qs = params.toString();
    let res: Response;
    try {
      res = await fetch(
        `${this.baseUrl}/v1/sessions/${sessionId}/transcript${qs === "" ? "" : `?${qs}`}`,
        { headers: this.headers() },
      );
    } catch (err) {
      throw isUnreachable(err) ? unreachableError(this.baseUrl, err) : toError(err);
    }
    if (!res.ok) throw await toYogError(res, "fetching transcript failed");
    const body = (await res.json()) as {
      session?: { id?: unknown; status?: unknown };
      messages?: unknown;
    };
    const id = typeof body.session?.id === "string" ? body.session.id : sessionId;
    const status = typeof body.session?.status === "string" ? body.session.status : "open";
    const rows = Array.isArray(body.messages) ? body.messages : [];
    return { sessionId: id, status, messages: rows as TranscriptMessage[] };
  }

  /**
   * Run one turn: `POST /v1/sessions/{id}/turns` and consume its SSE stream,
   * dispatching envelopes to `events`. When the stream dies after
   * `turn.started`, the stored turn is replayed from the turn-status
   * endpoint so the turn still reaches a terminal state.
   */
  async runTurn(prompt: string, model: string, events: TurnEvents): Promise<TurnOutcome> {
    if (!this.sessionId) throw new Error("runTurn called before open()");
    const sessionId = this.sessionId;
    let turnId: string | undefined;
    let sawFinished = false;
    let sawAborted = false;
    let failure: string | undefined;
    let serverError: string | undefined;

    /** Apply one envelope to the callbacks; used by stream and recovery. */
    const handle = (ev: TurnEnvelope): void => {
      const data = ev.data ?? {};
      switch (ev.type) {
        case "turn.started": {
          turnId = typeof data["turnId"] === "string" ? data["turnId"] : turnId;
          events.onStarted?.(turnId ?? "", typeof data["model"] === "string" ? data["model"] : model);
          return;
        }
        case "message.delta": {
          if (typeof data["text"] === "string") events.onDelta?.(data["text"]);
          return;
        }
        case "tool.call": {
          events.onToolCall?.(
            str(data["id"]),
            str(data["name"]),
            parseToolArgs(data["args"]),
          );
          return;
        }
        case "tool.result": {
          events.onToolResult?.(
            str(data["id"]),
            str(data["name"]),
            data["ok"] === true,
            data["result"],
            str(data["error"]) || undefined,
          );
          return;
        }
        case "turn.finished": {
          sawFinished = true;
          events.onFinish?.(typeof data["durationMs"] === "number" ? data["durationMs"] : 0);
          return;
        }
        case "turn.aborted": {
          sawAborted = true;
          events.onAborted?.(str(data["reason"]) || "turn aborted");
          return;
        }
        case "error": {
          serverError = str(data["message"]) || "unknown error";
          events.onError?.(str(data["code"]) || "error", serverError);
          return;
        }
        default:
          return; // unknown events are tolerated (forward compatibility)
      }
    };

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/sessions/${sessionId}/turns`, {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify({ prompt, model }),
      });
    } catch (err) {
      throw isUnreachable(err) ? unreachableError(this.baseUrl, err) : toError(err);
    }
    if (!res.ok) throw await toYogError(res, "running turn failed");

    const streamError = await readSseStream(res, handle);

    if (streamError !== undefined) {
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
        ...(recovered ? {} : { failure: "turn-status recovery failed" }),
      };
    }

    if (serverError !== undefined) return { ok: false, recovered: false, error: serverError, aborted: false };
    if (sawAborted) return { ok: false, recovered: false, aborted: true };
    if (!sawFinished) {
      return { ok: false, recovered: false, failure: "turn stream ended without a terminal event", aborted: false };
    }
    return { ok: true, recovered: false, aborted: false };
  }

  /**
   * Abort the session's current turn (POST /v1/sessions/{id}/abort): the
   * server kills the tool call in flight, closes the model stream, heals the
   * transcript, and settles the turn. Idempotent — an idle session answers
   * `ok` with `requested: false` and nothing is touched.
   */
  async abortTurn(): Promise<AbortTurnResult> {
    if (!this.sessionId) throw new Error("abortTurn called before open()");
    const sessionId = this.sessionId;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/sessions/${sessionId}/abort`, {
        method: "POST",
        headers: this.headers(),
      });
    } catch (err) {
      throw isUnreachable(err) ? unreachableError(this.baseUrl, err) : toError(err);
    }
    if (!res.ok) throw await toYogError(res, "aborting turn failed");
    const body = (await res.json()) as {
      ok?: unknown;
      status?: unknown;
      aborted?: { requested?: unknown; activeToolCall?: unknown };
    };
    const requested = body?.aborted?.requested === true;
    const call = body?.aborted?.activeToolCall;
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
   * Recovery path: `GET /v1/sessions/{id}/turns/{turnId}` and replay its
   * stored `{ type, data }` rows through the same handler.
   */
  private async recoverTurn(
    sessionId: string,
    turnId: string,
    handle: (ev: TurnEnvelope) => void,
  ): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/sessions/${sessionId}/turns/${turnId}`, {
        headers: this.headers(),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as {
        turn?: { events?: { type?: unknown; data?: unknown }[] };
      };
      for (const row of body?.turn?.events ?? []) {
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