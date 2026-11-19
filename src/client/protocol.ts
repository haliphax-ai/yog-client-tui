/**
 * The messages-channel protocol plumbing: the envelope version and the
 * `type` vocabulary the client sends, the envelope shapes, and the
 * envelope builder.
 *
 * A separate module so the transport (`client/transport.ts`) can use it
 * without importing the client itself — the dependency graph stays
 * one-way (`yogClient.ts` → `client/*`).
 */
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
] as const;

/** One message `type` the client can send. */
export type MessageType = (typeof MESSAGE_TYPES)[number];

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
