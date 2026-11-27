/**
 * The two tail measures the submit-time sync compares (#135): the last
 * row's seq in a fresh `transcript.get` dump (`transcriptTailSeqOf`),
 * and the tail stamp the store's entries carry (`transcriptSignature`).
 *
 * Its own module so `pollRunning.ts` (the reconnect-pickup refresh,
 * which rebuilds on the FULL signature below) and `transcriptRebuild.ts`
 * (the submit-time sync) can share them without importing each other —
 * a cycle the dependency rules (and honest layering) reject. Neither
 * tail is stored state: the dump side is derived per probe, the store
 * side from the copy stamps the rebuild paths already leave — raised by
 * the probe floor below for the rows a rebuild never stamped.
 */
import { getState } from "../core/index.ts";
import type { TranscriptResult } from "../client/index.ts";

/** The dump side of the tail-seq comparison. */
export function transcriptTailSeqOf(dump: TranscriptResult): number {
  return dump.messages[dump.messages.length - 1]?.seq ?? 0;
}

/** The full visible-content signature of a dump (the poll's gate):
 *  message count + tail seq + settle status + token weight. The sync
 *  compares the narrower tail-seq measure (above). */
export function transcriptSignatureOf(
  dump: TranscriptResult,
  status: string | undefined,
  total: number,
): string {
  const lastMessage = dump.messages[dump.messages.length - 1];
  const settled = status !== undefined && status !== "running";
  return [dump.messages.length, lastMessage?.seq ?? 0, settled ? status : "running", total].join(
    ":",
  );
}

/**
 * The tail floor: the highest seq a probe has confirmed the log accounts
 * for, kept per session. The rows a turn streamed LIVE carry tool-call
 * ids, not seq stamps — the numeric stamps alone under-measure the tail,
 * and the submit-time sync would re-append rows the user already watched
 * stream by. Both settle paths re-measure it (`noteTranscriptTailProbe`
 * in `transcriptRebuild.ts`): the submit path's own turn, and the idle
 * watch's foreign turns. Session-keyed so a /new or compaction (a fresh
 * session, seqs restart at 1) never inherits the old session's floor.
 */
let floor: { sessionId: string; seq: number } | undefined;

/** Record a probe's tail (monotonic per session; older probes never lower it). */
export function noteTranscriptTail(sessionId: string, seq: number): void {
  if (Number.isFinite(seq) && seq > transcriptFloorOf(sessionId)) floor = { sessionId, seq };
}

/** The floor for one session (0 when none — or another session's). */
export function transcriptFloorOf(sessionId: string): number {
  return floor !== undefined && floor.sessionId === sessionId ? floor.seq : 0;
}

/** Test reset (the floor is module state; `resetForTests` clears the store only). */
export function resetTranscriptTailForTests(): void {
  floor = undefined;
}

/** The store side of the tail-seq comparison: the tail the log carries —
 *  the highest numeric item stamp across its entries, raised by the
 *  probe floor for the live-rendered rows no stamp covers. */
export function transcriptSignature(sessionId: string): number {
  let maxSeq = transcriptFloorOf(sessionId);
  const entries = getState().entries;
  for (const entry of entries) {
    const id = entry.copyIds?.itemId;
    const n = id === undefined ? Number.NaN : Number(id);
    if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
  }
  return maxSeq;
}
