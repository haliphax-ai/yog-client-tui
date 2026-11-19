/**
 * Per-turn metrics shared by transcript rehydration: the usage/duration
 * shape a captured turn carries, keyed by the transcript row's `turnId`.
 * Its own module so both the presenter's rehydration surface and the
 * callers that build the metrics map import one definition.
 */
import type { TokenUsage } from "../yogClient.ts";

/** Per-turn metrics for a rehydrated turn (usage/duration as captured). */
export interface TranscriptTurnMetrics {
  usage?: TokenUsage;
  durationMs?: number;
}

/** Options for transcript rehydration entries. */
export interface TranscriptRehydrateOpts {
  /** Per-turn metrics, keyed by the transcript row's `turnId` (row id). */
  turns?: Map<number, TranscriptTurnMetrics>;
}
