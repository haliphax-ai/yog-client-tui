/**
 * Log append helpers for the composition root: how a producer adds lines
 * to the shared store log and reads the next transcript message seq.
 *
 * The composition root (main.ts) hands these to the client/presenter
 * wiring; `ui/` stays out of the business of shaping startup notes and
 * the client's `append` callback stays a plain function.
 */
import { getState, setState } from "../core/index.ts";
import type { LogEntry } from "../core/index.ts";

/** Push one entry to the log and notify subscribers. */
export function pushLines(kind: LogEntry["kind"], lines: string[]): void {
  const state = getState();
  state.entries.push({ kind, lines });
  setState({ entries: state.entries });
}

/**
 * The next transcript message seq: the server numbers messages
 * monotonically per session, so the user prompt the next turn appends
 * will carry this seq as its item id (one past the current tail).
 */
export function nextMessageSeq(): string {
  const entries = getState().entries;
  // Rehydrated rows stamp `String(message.seq)`; the live tail is the
  // highest id seen so far. Non-numeric ids (tool-call ids on rehydrated
  // tool rows) are skipped, not counted.
  let maxSeq = 0;
  for (const entry of entries) {
    const id = entry.copyIds?.itemId;
    const n = id === undefined ? Number.NaN : Number(id);
    if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
  }
  return String(maxSeq + 1);
}

/** Replace the log's entries (a full rebuild: rehydrate, /new). */
export function resetEntries(entries: LogEntry[]): void {
  setState({ entries });
}
