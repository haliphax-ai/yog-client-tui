/**
 * The client domain's public door: everything outside `src/client/`
 * imports from here, never from an inner module.
 *
 * `client.ts` owns the transport (the `YogClient` class plus the
 * capability/session-stream types it introduces); the other `client/`
 * modules carry the shared mechanics (wire shapes, protocol envelopes,
 * SSE, errors, turn outcome plumbing). The barrel exposes the public
 * surface of both without letting importers reach past the door —
 * `client.ts` itself consumes the mechanics directly, not through here.
 */
export {
  YogClient,
  type Capabilities,
  type ServerCommandDescriptor,
  type SessionStream,
} from "./client.ts";
export { YogError, isUnreachable, unreachableError, toYogError } from "./errors.ts";
export { parseToolArgs } from "./decode.ts";
export { parseFrame, toEnvelope, readSseStream } from "./sse.ts";
export type {
  AbortTurnResult,
  ActiveToolCall,
  BackgroundJob,
  JobsResult,
  ToolResultEvent,
  TranscriptMessage,
  TranscriptResult,
  TurnEnvelope,
  TurnEvents,
  TokenUsage,
  TurnOutcome,
  TurnEventType,
} from "./wire.ts";
