/**
 * The presenter's host surface: what the live-turn event handlers need
 * from the application (the shared log array, the append/render hooks,
 * the terminal width, and the copy/identity/token hooks). The
 * composition root implements it; `turnEvents.ts` consumes it. One
 * module so the handler factory and the presenter share one definition.
 */
import type { LogEntry } from "./entries.ts";

/** Anything that can be pushed to the log and schedules a redraw. */
export type AppendEntry = (kind: LogEntry["kind"], lines: string[]) => void;

/** Presenter-facing slice of the shared UI state. */
export interface TurnHost {
  entries: LogEntry[];
  append: AppendEntry;
  /** Terminal width (columns) used to fit tool-call lines. */
  width: () => number;
  /** Schedule a redraw (coalesced by the render scheduler). */
  requestRender: () => void;
  /**
   * The next transcript message seq (the item id a user prompt will
   * carry once the server persists it). The presenter stamps it on the
   * user entry so copy identity (#109) matches rehydrated rows.
   */
  nextMessageSeq: () => string;
  /**
   * The session token total before this turn ran (used to show the turn's
   * incremental tokens in the summary line). Omit to fall back to showing
   * the full reported total.
   */
  prevTokenTotal?: () => number;
  /**
   * Called at most once per round, with the round's real promptDelta, when
   * the round's LAST tool result lands — so live session totals fold each
   * round in exactly once, even for batches.
   */
  onRoundDelta?(delta: number): void;
}
