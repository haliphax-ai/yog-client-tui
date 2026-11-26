/**
 * Per-turn metrics shared by transcript rehydration: the usage/duration
 * shape a captured turn carries, keyed by the transcript row's `turnId`.
 * Its own module so both the presenter's rehydration surface and the
 * callers that build the metrics map import one definition.
 */
import type { TokenUsage } from "../client/index.ts";

/** Per-turn metrics for a rehydrated turn (usage/duration as captured).
 *  `wake` marks a background-jobs wake turn — the prompt row styles as
 *  harness-internal (a notice block), never a user bubble. */
export interface TranscriptTurnMetrics {
  usage?: TokenUsage;
  durationMs?: number;
  wake?: boolean;
}

/** Options for transcript rehydration entries. */
export interface TranscriptRehydrateOpts {
  /** Per-turn metrics, keyed by the transcript row's `turnId` (row id). */
  turns?: Map<number, TranscriptTurnMetrics>;
}
