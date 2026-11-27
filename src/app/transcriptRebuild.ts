/**
 * Transcript-driven log rebuilds — the moments the whole log is (re)built
 * from a server transcript dump: the initial rehydrate seed (placeholders
 * first, #67), a running-turn poll refresh, the post-compaction rebuild,
 * and the submit-time sync (#135). Each produces the entries array and the
 * status-bar token total from one `TranscriptResult`.
 *
 * The pending rehydrate job is tracked here too: `driveRehydrate` swaps
 * real entries in for the placeholders bottom-up, a few groups per frame
 * (the part the user actually sees materializes first), aborting if the
 * log shape changes underneath it (/new, a poll replacement).
 */
import {
  placeholderLogEntries,
  rehydrateGroupIndices,
  rehydrateGroups,
  transcriptLogEntries,
} from "../core/index.ts";
import { perTurnDeltas, toTranscriptEntries, wakeSubstitute } from "../core/index.ts";
import { estimatedContextTotal, finalContextTotal } from "../core/index.ts";
import { getState, setState } from "../core/index.ts";
import type { LogEntry } from "../core/index.ts";
import type { TranscriptResult, YogClient } from "../client/index.ts";
import { pushLines } from "./logFeed.ts";
import { noticeLine } from "../core/index.ts";
import { emitDebug } from "../ui/index.ts";
import {
  noteTranscriptTail,
  transcriptSignature,
  transcriptTailSeqOf,
} from "./transcriptSignature.ts";

/** Terminal width (columns) for line fitting; 80 when headless. */
export function termCols(): number {
  return process.stdout.columns ?? 80;
}

/** The session token weight a transcript dump carries: the last known
 *  provider total, else the tokenx estimate over the rows (labeled ~). */
export function transcriptTokenWeight(dump: TranscriptResult): number {
  let total = finalContextTotal(dump.turns);
  if (total <= 0) {
    const running = [...(dump.turns ?? [])].reverse().find((t) => t.status === "running");
    if (running !== undefined) total = running.usage?.total_tokens ?? 0;
  }
  if (total <= 0) total = estimatedContextTotal(dump.messages);
  return total;
}

/** The flat log entries for a dump at the current width (poll refresh). */
export function entriesForDump(dump: TranscriptResult): LogEntry[] {
  return transcriptLogEntries(toTranscriptEntries(dump.messages), termCols(), {
    turns: perTurnDeltas(dump.turns),
  });
}

/** A poll refresh's token total for the status bar. */
export function statusTotals(total: number): { prompt: number; completion: number; total: number } {
  return { prompt: 0, completion: 0, total };
}

/** Replace the whole log + token total from a dump (poll refresh). */
export function applyDump(dump: TranscriptResult, priorEntries: LogEntry[]): void {
  setState({
    entries: entriesForDump(dump),
    tokenTotals: statusTotals(transcriptTokenWeight(dump)),
  });
  void priorEntries;
}

/**
 * The submit-time transcript sync (#135): one pre-submit probe of the
 * server transcript. A no-op (and the caller submits immediately) when
 * the rows have not advanced since the last rebuild; INCREMENTAL when
 * they have — only the new tail is appended, so rows the user already
 * watched stream by stay put (the wholesale rebuild was the flood #144);
 * a chrome-preserving full rebuild only when the log holds nothing to
 * grow from (its first probe); a debug note and proceed when the probe
 * itself fails — the sync is best effort and never blocks a submit.
 *
 * The comparison: the store's tail stamp (`transcriptSignature()` — the
 * numeric item stamps the rebuild paths leave, raised by the probe
 * floor the settle paths keep for live-rendered rows) against the fresh
 * dump's tail (`transcriptTailSeqOf`).
 */
export async function syncTranscriptOnSubmit(client: YogClient): Promise<void> {
  try {
    const dump = await client.getTranscript();
    const sessionId = client.sessionId;
    if (sessionId === undefined) return;
    const tail = transcriptTailSeqOf(dump);
    const carried = transcriptSignature(sessionId);
    if (tail === carried) return;
    setState({
      entries: [...getState().entries, ...entriesForDumpAfter(dump, carried)],
      tokenTotals: statusTotals(transcriptTokenWeight(dump)),
    });
    // The floor rises only after the tail actually landed: the sync's rows
    // are now accounted for even though (some of) them carry no numeric
    // item stamp in the log.
    noteTranscriptTail(sessionId, tail);
  } catch (err) {
    // Best effort: a failed probe proceeds with the submit (#135).
    emitDebug([`transcript sync skipped: ${err instanceof Error ? err.message : String(err)}`]);
  }
}

/**
 * The new tail of a dump, as flat log entries: the rows after `after`
 * (the tail the log already carries), converted through the same step
 * walk a full rebuild uses (`transcriptLogEntries` — pairing, orphan
 * results, and the turn summaries of the turns the rows belong to). An
 * empty array when the dump holds nothing past that tail (defensive:
 * the caller only calls this after the tail moved).
 */
export function entriesForDumpAfter(dump: TranscriptResult, after: number): LogEntry[] {
  const fresh = dump.messages.filter((m) => m.seq > after);
  if (fresh.length === 0) return [];
  return entriesForDump({ ...dump, messages: fresh });
}

/** The post-compaction rebuild: fresh log + estimated context weight. */
export function applyCompaction(dump: TranscriptResult): void {
  setState({
    entries: entriesForDump(dump),
    tokenTotals: statusTotals(estimatedContextTotal(dump.messages)),
  });
}

/** The rehydrate seed: startup notes stay, transcript rows land as O(1)
 *  placeholders (no glamour) so the first frame paints instantly. */
export function placeholderSeed(dump: TranscriptResult): LogEntry[] {
  return placeholderLogEntries(
    wakeSubstitute(toTranscriptEntries(dump.messages), perTurnDeltas(dump.turns)),
    termCols(),
  );
}

/** A pending bottom-up rehydration job (#67). */
interface RehydrateJob {
  groups: LogEntry[][];
  indices: number[][];
  /** Log position of each transcript row's placeholder at seed time. */
  logPos: number[];
}

let pendingRehydrate: RehydrateJob | undefined;

/** Start the job: the real entries for the dump, grouped bottom-up. The
 *  logged positions are read off the CURRENT log — the placeholder for
 *  transcript row i sits wherever it was seeded (after the startup notes),
 *  never at index i. */
export function stageRehydrate(dump: TranscriptResult): void {
  const transcriptEntries = toTranscriptEntries(dump.messages);
  const cols = termCols();
  pendingRehydrate = {
    groups: rehydrateGroups(transcriptEntries, cols, { turns: perTurnDeltas(dump.turns) }),
    indices: rehydrateGroupIndices(transcriptEntries),
    logPos: placeholderPositions(getState().entries, transcriptEntries.length),
  };
}

/** The log position of each of the last `count` placeholder entries: the
 *  seed appends them after the startup notes, in transcript order. */
function placeholderPositions(log: readonly LogEntry[], count: number): number[] {
  const positions: number[] = [];
  for (let i = log.length - 1; i >= 0 && positions.length < count; i--) {
    if (log[i]?.kind === "placeholder") positions.unshift(i);
  }
  return positions;
}

/** Drop any pending job (the caller is rebuilding the log its own way). */
export function clearRehydrate(): void {
  pendingRehydrate = undefined;
}

/** One bottom-up rehydrate job in progress (module-scoped: only one runs). */
interface RehydrateDriver {
  /** The log length the job seeded (a shorter log aborts the job). */
  seededLength: number;
  /** Index of the next group to swap (counts down; < 0 = done). */
  nextGroup: number;
  cancelled: boolean;
}

/**
 * Swap real entries in for placeholders, last transcript group first
 * (bottom-up — the part the user actually sees materializes first).
 * Each tick swaps a small batch, then `setState` coalesces one frame;
 * far-head groups glamour later, never before the visible region.
 * Runs to completion even if the user starts typing — swaps only replace
 * placeholder positions, never user-appended live entries (live entries
 * append after the rehydrated span, tracked via a generation check: if
 * the log no longer holds our placeholders at the expected positions,
 * the job aborts silently).
 *
 * The live log is re-read each tick so a concurrent poll replacement
 * (running-turn pickup) wins and aborts the job via the generation
 * check, instead of being clobbered by a stale snapshot.
 */
export function driveRehydrate(): void {
  const job = pendingRehydrate;
  if (job === undefined) return;
  const driver: RehydrateDriver = {
    seededLength: job.logPos.length,
    nextGroup: job.groups.length - 1,
    cancelled: false,
  };
  const tick = (): void => tickRehydrate(job, driver, tick);
  // First tick after the placeholder frame has painted.
  setTimeout(tick, 0);
}

/** One driver tick: swap one batch of groups, commit the log, then
 *  reschedule until the job drains. The commit is unconditional — the
 *  subscribers (the render scheduler) must see every batch, and the
 *  reschedule must happen no matter how fast the batch was: a fast batch
 *  that "returns early" strands every placeholder it did not swap. */
function tickRehydrate(job: RehydrateJob, driver: RehydrateDriver, tick: () => void): void {
  const log = getState().entries;
  if (log.length < driver.seededLength && driver.nextGroup >= 0) {
    // Log shrank (e.g. /new cleared it) — abort the job.
    driver.cancelled = true;
    pendingRehydrate = undefined;
    return;
  }
  if (driver.cancelled || driver.nextGroup < 0) {
    pendingRehydrate = undefined;
    return;
  }
  swapBatches(job, driver, log, 6);
  setState({ entries: log });
  if (driver.nextGroup >= 0) setTimeout(tick, 0);
  else pendingRehydrate = undefined;
}

/** Swap up to `budget` groups into `log`; each swap replaces the group's
 *  covered placeholders (a generation check first) and shifts the logged
 *  positions above it when the group's length differs. */
function swapBatches(
  job: RehydrateJob,
  driver: RehydrateDriver,
  log: LogEntry[],
  budget: number,
): void {
  let swapped = 0;
  while (driver.nextGroup >= 0 && swapped < budget) {
    const group = job.groups[driver.nextGroup] as LogEntry[];
    const covered = job.indices[driver.nextGroup] as number[];
    const firstPos = job.logPos[covered[0] as number] as number;
    // Generation check: the placeholder must still be there.
    if (log[firstPos]?.kind !== "placeholder") {
      driver.cancelled = true;
      pendingRehydrate = undefined;
      return;
    }
    // Replace the covered placeholders (contiguous) with the group.
    log.splice(firstPos, covered.length, ...group);
    const delta = group.length - covered.length;
    if (delta !== 0) shiftPositions(job.logPos, firstPos, delta);
    driver.nextGroup -= 1;
    swapped += 1;
  }
}

/** Shift every logged position above `firstPos` by `delta` (a swap changed
 *  the log length between the swapper's anchor and the tail). */
function shiftPositions(logPos: number[], firstPos: number, delta: number): void {
  for (let k = 0; k < logPos.length; k++) {
    if ((logPos[k] as number) > firstPos) logPos[k] = (logPos[k] as number) + delta;
  }
}

/** The compaction/handoff result note (`fresh transcript started …`). */
export function compactionNote(kind: string, reply: Record<string, unknown>): void {
  const truncatedNote = reply["truncated"] === true ? " (input was middle-truncated)" : "";
  const summary = typeof reply["summary"] === "string" ? reply["summary"] : "";
  const model = typeof reply["model"] === "string" ? reply["model"] : "?";
  pushLines(
    "notice",
    noticeLine(
      "notice",
      kind,
      `fresh transcript started (model ${model}, summary ${summary.length} chars${truncatedNote})`,
    ),
  );
}
