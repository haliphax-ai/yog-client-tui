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
 * side from the copy stamps the rebuild paths already leave.
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
/** The store side of the tail-seq comparison: the tail the log carries. */
export function transcriptSignature(): number {
  const entries = getState().entries;
  let maxSeq = 0;
  for (const entry of entries) {
    const id = entry.copyIds?.itemId;
    const n = id === undefined ? Number.NaN : Number(id);
    if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
  }
  return maxSeq;
}
