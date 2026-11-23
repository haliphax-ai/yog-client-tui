/**
 * The transport's single public door.
 *
 * `src/yogClient.ts` owns the transport; the `client/` modules carry the
 * shared mechanics (wire shapes, protocol envelopes, SSE, errors, turn
 * outcome plumbing). This barrel exposes those internals without letting
 * importers reach past the door — `yogClient.ts` itself consumes the same
 * barrel.
 */
export {
  MESSAGE_TYPES,
  MESSAGE_VERSION,
  buildEnvelope,
  type MessageEnvelope,
  type MessageResponse,
  type MessageType,
} from "./protocol.ts";
export {
  YogError,
  authHeaders,
  isUnreachable,
  toError,
  toYogError,
  unreachableError,
} from "./errors.ts";
export { parseToolArgs, parseUsage } from "./decode.ts";
export { turnEnvelopeHandler } from "./envelope.ts";
export {
  type ParsedFrame,
  parseFrame,
  toEnvelope,
  extractData,
  type ConsumedStream,
  readSseStream,
  consumeStream,
} from "./sse.ts";
export { sessionOf, statusOf, type TurnRow, transcriptTurns } from "./transcriptRows.ts";
export { replayStoredTurn, abortResultOf, capabilityQuery } from "./replies.ts";
export { awaitTerminal, settleTurn, type Recover } from "./turnSettle.ts";
export {
  str,
  TurnObservation,
  directOutcome,
  recoveredOutcome,
  streamGapOutcome,
  emptyRecoveryOutcome,
} from "./turnOutcome.ts";
export { Transport } from "./transport.ts";
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
  TurnEventType,
} from "./wire.ts";
