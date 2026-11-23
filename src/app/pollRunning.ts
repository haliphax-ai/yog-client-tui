/**
 * Reconnect pickup (yog#88 / yog#31): a `running` turn found at resume —
 * spinner on, a startup note, and a poll that replays each fresh
 * transcript dump through the same rebuild path a resume uses, so
 * completed rows appear before the turn settles.
 */
import { toTranscriptEntries } from "../core/index.ts";
import { transcriptLogEntries } from "../core/index.ts";
import { perTurnDeltas } from "../core/index.ts";
import { setState } from "../core/index.ts";
import type { LogEntry } from "../core/index.ts";
import type { TranscriptResult, YogClient } from "../client/index.ts";
import { statusTotals, termCols, transcriptTokenWeight } from "./transcriptRebuild.ts";

/** The poll cadence (ms) while a resumed turn is in flight. */
const POLL_MS = 2000;

/**
 * Poll the running turn: rebuild the log from each fresh dump whenever
 * the visible content changes — not only when the token total climbs.
 * The old gates (`usage.total_tokens` must be present, total must exceed
 * the last total) meant a running turn with no reported usage yet, or
 * with usage that only moves at round boundaries, never landed in the
 * log while generating, and the settled turn could be dropped by the
 * total gate as well. Signature on message count + last seq + settled
 * flag + total: any of those moving is visible.
 */
export function pollRunningTurn(
  client: YogClient,
  turnId: number,
  chrome: LogEntry[],
  hooks: { start(): void; stop(): void },
): void {
  hooks.start();
  let lastSignature = "";
  const timer: NodeJS.Timeout = setInterval(() => {
    void (async () => {
      try {
        const fresh = await client.getTranscript();
        const row = (fresh.turns ?? []).find((t) => t.turnId === turnId);
        if (row === undefined) return;
        const settled = row.status !== undefined && row.status !== "running";
        const entries = transcriptLogEntries(toTranscriptEntries(fresh.messages), termCols(), {
          turns: perTurnDeltas(fresh.turns),
        });
        const total = transcriptTokenWeight(fresh);
        const signature = signatureOf(fresh, row.status, total);
        if (!settled && signature === lastSignature) return;
        lastSignature = signature;
        setState({
          entries: [...chrome, ...entries],
          tokenTotals: statusTotals(total),
        });
        if (settled) {
          clearInterval(timer);
          hooks.stop();
        }
      } catch {
        // Polling is best effort: a failed probe keeps the previous state
        // and retries on the next tick.
      }
    })();
  }, POLL_MS);
}

/** The visible-content signature of a dump (see the module comment). */
function signatureOf(dump: TranscriptResult, status: string | undefined, total: number): string {
  const lastMessage = dump.messages[dump.messages.length - 1];
  const settled = status !== undefined && status !== "running";
  return [dump.messages.length, lastMessage?.seq ?? 0, settled ? status : "running", total].join(
    ":",
  );
}
