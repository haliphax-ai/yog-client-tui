/**
 * The turn-boundary tracker shared by the transcript walks: watches each
 * row's turn id and, when the walk crosses into a new turn, hands the
 * sink the previous turn's summary line (`runtime … · N tool calls · M
 * tokens`) — but only when the server captured metrics for it. Both the
 * flat converter and the grouped (bottom-up) walker drive one instance,
 * which is why their summaries always agree.
 */
import { formatRuntime, formatTokenTotal } from "./toolFormat.ts";
import type { TokenUsage } from "../yogClient.ts";
import type { LogEntry } from "./entries.ts";
import type { TranscriptEntry } from "./transcript.ts";
import type { TranscriptTurnMetrics } from "./turnMetrics.ts";

export type { TranscriptTurnMetrics } from "./turnMetrics.ts";

/** Turn-level total for a usage object (total field, else prompt+completion). */
export function usageTotal(usage: TokenUsage | undefined): number {
  if (usage === undefined) return 0;
  if (typeof usage.total_tokens === "number") return usage.total_tokens;
  return (
    (typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0) +
    (typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0)
  );
}
/**
 * The turn-boundary tracker shared by both walks: watches each row's turn
 * id and, when the walk crosses into a new turn, hands the sink the
 * previous turn's summary line (`runtime … · N tool calls · M tokens`) —
 * but only when the server captured metrics for it.
 */
export class TurnTracker {
  private active: number | null = null;
  private callCount = 0;
  private readonly metrics: ReadonlyMap<number, TranscriptTurnMetrics>;
  private readonly sink: (entry: LogEntry) => void;

  constructor(
    metrics: ReadonlyMap<number, TranscriptTurnMetrics>,
    sink: (entry: LogEntry) => void,
  ) {
    this.metrics = metrics;
    this.sink = sink;
  }

  /** Cross a row boundary: flush the previous turn when `nextTurnId` differs. */
  cross(nextTurnId: number | null): void {
    if (this.active !== null && nextTurnId !== this.active) {
      this.flushOne(this.active);
      this.callCount = 0;
    }
    this.active = nextTurnId;
  }

  /** Count this row's tool calls against the active turn. */
  countCalls(n: number): void {
    this.callCount += n;
  }

  /** End-of-transcript boundary: flush whatever turn is still active. */
  finish(): void {
    if (this.active === null) return;
    this.flushOne(this.active);
    this.active = null;
  }

  private flushOne(turnId: number): void {
    const m = this.metrics.get(turnId);
    if (m === undefined) return;
    if (m.durationMs === undefined && usageTotal(m.usage) <= 0) return;
    this.sink(turnSummaryEntry(m, this.callCount));
  }
}

/** The per-turn summary status line for one captured turn's metrics. */
function turnSummaryEntry(metrics: TranscriptTurnMetrics, callCount: number): LogEntry {
  const parts: string[] = [];
  if (metrics.durationMs !== undefined) parts.push(`runtime ${formatRuntime(metrics.durationMs)}`);
  parts.push(`${callCount} tool call${callCount === 1 ? "" : "s"}`);
  const total = usageTotal(metrics.usage);
  if (total > 0) parts.push(`${formatTokenTotal(total)} tokens`);
  return { kind: "status", lines: [parts.join(" · ")] };
}

/** The transcript row's numeric turn id (null when absent/unparseable).
 *  Transcript turn ids are the server's turn-row ids (numbers); numeric
 *  strings and odd payloads are tolerated defensively. */
export function turnIdOf(e: TranscriptEntry): number | null {
  const raw = e.raw.turnId;
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
