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

import { TurnObservation } from "./turnOutcome.ts";
import { YogError } from "./errors.ts";
import { turnEnvelopeHandler } from "./envelope.ts";
import { sessionOf, statusOf, transcriptTurns } from "./transcriptRows.ts";
import { abortResultOf, capabilityQuery, replayStoredTurn } from "./replies.ts";
import { awaitTerminal, settleTurn } from "./turnSettle.ts";
import { Transport } from "./transport.ts";
import { consumeStream, parseFrame, toEnvelope } from "./sse.ts";
import type {
  AbortTurnResult,
  ActiveToolCall,
  ToolResultEvent,
  TranscriptMessage,
  TranscriptResult,
  TurnEnvelope,
  TurnEvents,
  TokenUsage,
  TurnOutcome,
} from "./wire.ts";

// The wire shapes are defined in wire.ts (so the client/ helpers can
// share them without importing this module); they are re-exported
// here as the transport's public surface.
export type {
  AbortTurnResult,
  ActiveToolCall,
  ToolResultEvent,
  TranscriptMessage,
  TranscriptResult,
  TurnEnvelope,
  TurnEvents,
  TokenUsage,
  TurnOutcome,
};

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

/** The terminal-event signal one `runTurn` waits on: resolved by the
 *  envelope handler when `turn.finished`/`turn.aborted`/`error` lands. */
function terminalSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** The `turn.start` payload: prompt-only (the server hydrates prior
 *  context), plus the bound stream id when the hello has landed. */
function turnStartParams(
  prompt: string,
  model: string,
  stream: SessionStream,
): Record<string, unknown> {
  return {
    prompt,
    model,
    ...(stream.streamId !== undefined ? { streamId: stream.streamId } : {}),
  };
}

/** The `transcript.get` params: `afterSeq` / `limit` when given. */
function transcriptParams(after?: number, limit?: number): Record<string, unknown> {
  return {
    ...(after !== undefined ? { afterSeq: after } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

/** Assemble a transcript dump result from the reply (the shape the
 *  rehydration path consumes). */
function transcriptResultOf(
  body: { session?: { id?: unknown; status?: unknown }; messages?: unknown; turns?: unknown },
  fallbackSession: string,
): TranscriptResult {
  const turns = transcriptTurns(body.turns);
  return {
    sessionId: sessionOf(body, fallbackSession),
    status: statusOf(body),
    messages: (Array.isArray(body.messages) ? body.messages : []) as TranscriptMessage[],
    ...(turns.length > 0 ? { turns } : {}),
  };
}

/** Decode one raw SSE block into an envelope (undefined for ignored shapes). */
function decodeEnvelope(block: string): TurnEnvelope | undefined {
  return toEnvelope(parseFrame(block) ?? { event: "", data: block });
}

/** The yog contract client. One instance per session. */
export class YogClient extends Transport {
  /** Session id once `open()` has succeeded. */
  sessionId: string | undefined;
  /** Capabilities from the startup probe. */
  capabilities: Capabilities | undefined;

  constructor(baseUrl: string) {
    super(baseUrl);
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
      const res = await this.fetchStream(sessionId, controller, settle);
      if (res === undefined) return; // settle already carried the failure
      const { streamId: id, streamError } = await consumeStream(res, onEvent, decodeEnvelope);
      streamId = id;
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
    const res = await this.fetchRaw(
      `/v1/capabilities${capabilityQuery(model)}`,
      { headers: this.headers() },
      "capabilities request failed",
    );
    const body = (await res.json()) as Capabilities;
    this.capabilities = body;
    return body;
  }

  /** Create a session (`POST /v1/sessions`) and remember its id. */
  async open(): Promise<string> {
    const res = await this.fetchRaw(
      "/v1/sessions",
      { method: "POST", headers: this.headers() },
      "creating session failed",
    );
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
    const body = (await this.send(
      sessionId,
      "transcript.get",
      transcriptParams(after, limit),
      "fetching transcript failed",
    )) as {
      session?: { id?: unknown; status?: unknown };
      messages?: unknown;
      turns?: unknown;
    };
    return transcriptResultOf(body, sessionId);
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
    const observed = new TurnObservation();
    // The session stream is LONG-LIVED: it stays open (with periodic
    // heartbeats) past the turn's terminal event. Settling `runTurn` must
    // therefore race the stream's death against the arrival of a terminal
    // event — awaiting the closed stream alone would hang forever once
    // `turn.finished`/`turn.aborted`/`error` has already landed (which
    // is what left the UI spinner spinning after a successful turn).
    const terminal = terminalSignal();
    const handle = turnEnvelopeHandler(observed, events, model, terminal.resolve);

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
      turnStartParams(prompt, model, stream),
      "running turn failed",
    );
    // Wait for the turn's terminal event on the stream, or for the stream
    // itself to die — whichever comes first. `readSseStream` resolves on a
    // clean end with `undefined`, so a stream that ends after the terminal
    // event is indistinguishable from one that ends before it; the flags
    // above (checked after `streamDone` settles) decide which it was.
    const [streamError, terminalWon] = await awaitTerminal(streamDone, terminal.promise);
    stream.close();
    return await settleTurn(
      sessionId,
      { observed, events, handle },
      { streamError: streamError ?? undefined, terminalWon },
      (id: string) => this.recoverTurn(id, handle),
    );
  }

  /**
   * Abort the session's current turn (`turn.abort` message): the server
   * kills the tool call in flight, closes the model stream, heals the
   * transcript, and settles the turn. Idempotent — an idle session answers
   * `ok` with `requested: false` and nothing is touched.
   */
  async abortTurn(): Promise<AbortTurnResult> {
    if (!this.sessionId) throw new Error("abortTurn called before open()");
    const body = await this.send(this.sessionId, "turn.abort", {}, "aborting turn failed");
    return abortResultOf(body);
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
  private async recoverTurn(turnId: string, handle: (ev: TurnEnvelope) => void): Promise<boolean> {
    const sessionId = this.sessionId as string;
    try {
      const body = await this.send(sessionId, "turn.get", { turnId }, "recovering turn failed");
      replayStoredTurn(body, handle);
      return true;
    } catch {
      return false;
    }
  }
}
