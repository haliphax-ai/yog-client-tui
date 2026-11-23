/**
 * Turn presenter — SSE turn events → chat-log/transcript state updates.
 *
 * Pure event translation: no rendering, no terminal access. `main.ts` wires
 * the returned {@link TurnEvents} callbacks to the client and supplies the
 * column width for tool-line fitting. The live handlers live in
 * `turnEvents.ts` (with the host surface in `turnHost.ts`); the shared
 * entry builders in `toolEntries.ts` also serve transcript rehydration
 * (`rehydrate.ts`), and the placeholder stand-ins live in
 * `placeholder.ts` — so a restored row renders exactly like a live one.
 *
 * This module is the composition seam: it assembles the live handlers and
 * lifecycle into the `TurnPresenter` the client drives, and re-exports
 * the builders/rehydration surface the rest of the app imports.
 */
import { type TurnEvents } from "../client/index.ts";
import { createTurnEventHandlers, createTurnLifecycle, ProseStream } from "./turnEvents.ts";
import type { TurnHost } from "./turnHost.ts";

export type { TurnHost, AppendEntry } from "./turnHost.ts";
export {
  toolCallEntry,
  annotateToolCall,
  toolResultChunk,
  toolResultEntry,
  toolResultEntries,
} from "./toolEntries.ts";
export {
  transcriptLogEntries,
  rehydrateGroups,
  rehydrateGroupIndices,
  type TranscriptTurnMetrics,
  type TranscriptRehydrateOpts,
} from "./rehydrate.ts";
export { placeholderForTranscriptEntry, placeholderLogEntries } from "./placeholder.ts";

/** Mutable turn session handed to the client's `TurnEvents` handlers. */
export interface TurnPresenter {
  /** Chat-log mutations produced by the turn's events. */
  events: TurnEvents;
  /** User message + reset lines (spinner already started). */
  begin(input: string): void;
  /**
   * Turn finished: stop marking the assistant entry as streaming (the
   * server persists the turn; the client keeps no history).
   */
  finish(): void;
  /** A turn failed (non-ok outcome or thrown error): record the line. */
  fail(detail: string): void;
}

/** Create the presenter for one turn (one `submit()`). */
export function createTurnPresenter(host: TurnHost): TurnPresenter {
  const prose = new ProseStream(host);
  return {
    events: createTurnEventHandlers(host, prose),
    ...createTurnLifecycle(host, prose),
  };
}
