/**
 * The yog wire shapes: the typed events, outcomes, and transcript rows the
 * transport (src/client/client.ts) and its client/ helpers share.
 *
 * A separate module so the helpers can import the shapes WITHOUT
 * importing the client itself (no client/ → client.ts edge, so the
 * dependency graph stays one-way).
 */
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

/** One `tool.result` event, as the wire carries it: the call it answers,
 *  its outcome, and the token accounting for the round/context. The
 *  fields travel together — the presenter consumes them as one value. */
export interface ToolResultEvent {
  /** The tool-call id this result answers (the transcript item id). */
  id: string;
  /** The tool name ("" when the server omitted it). */
  name: string;
  /** The call succeeded. */
  ok: boolean;
  /** The result payload (undefined/null when the call failed). */
  result: unknown;
  /** Failure detail (when `ok` is false). */
  error?: string;
  /** The round's real provider usage (round attribution, not per-call). */
  usage?: TokenUsage;
  /** Context growth this round's call+result added (prompt_tokens diff). */
  promptDelta?: number;
  /** Estimated tokens this result adds to context (tokenx estimate). */
  resultTokens?: number;
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
  onToolResult?(result: ToolResultEvent): void;
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

/** One background job row (`jobs.get` list/detail; verbatim wire fields). */
export interface BackgroundJob {
  /** The job id (the pool run key and the transcript's `backgroundJobId`). */
  readonly id: string;
  /** Owning session id. */
  readonly sessionId: string;
  /** Tool name (e.g. `bash`). */
  readonly tool: string;
  /** Raw JSON arguments exactly as the registry received them. */
  readonly argsJson: string | null;
  /** The call's start (detach) time, epoch ms. */
  readonly startedAt: number;
  /** The settle time, epoch ms (unset while running). */
  endedAt?: number;
  /** Lifecycle state. */
  state: string;
  /** The retained (capped) result once the call settles. */
  result?: unknown;
  /** The worker wrapper child's pid, when known. */
  pid?: number;
  /** Termination reason (state `terminated` only). */
  termReason?: string;
  /** True once the result has been delivered in a wake prompt. */
  delivered?: boolean;
}

/** The `jobs.get` reply: the session's job rows (list) or one row (detail). */
export interface JobsResult {
  /** The session's jobs in start order (absent on a single-job reply). */
  jobs?: BackgroundJob[];
  /** The named job (detail replies). */
  job?: BackgroundJob;
}
