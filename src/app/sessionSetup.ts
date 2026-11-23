/**
 * Session resolution for the composition root: the startup sequence that
 * turns CLI flags + stored state into a live session and its transcript
 * — `--new` / `--session <id>` / the stored `lastSessionId` / create.
 *
 * A resumable id is validated with `reopen` (a stale id falls back to a
 * fresh session with a one-line note) and hydrated from the server
 * transcript; transport failures propagate — only a stale id is
 * recoverable. The caller decides what to do with the result: seed the
 * log, start the rehydrate job, poll a running turn.
 */
import {
  estimatedContextTotal,
  finalContextTotal,
  perTurnDeltas,
  toTranscriptEntries,
} from "../core/index.ts";
import { formatTokenTotal } from "../core/index.ts";
import { noticeLine } from "../core/index.ts";
import type { LogEntry } from "../core/index.ts";
import { YogError, type TranscriptResult, type YogClient } from "../client/index.ts";
import { placeholderLogEntries } from "../core/index.ts";

/** What resolveSession produced: the resume facts and the log seed. */
export interface ResolvedSession {
  /** The running turn to poll (reconnect pickup), or undefined. */
  runningTurnId?: number;
  /** The transcript dump, when a session resumed (for reconnect pickup). */
  dump?: TranscriptResult;
  /** Restored context weight (last known total) when resuming; 0 otherwise. */
  resumedTokenWeight: number;
  /** Startup notes + the rehydrate seed, in log order. */
  seed: LogEntry[];
  /** Startup notes only (no transcript rows): a poll rebuild keeps them
   *  ahead of the fresh transcript without duplicating the resume rows. */
  notes: LogEntry[];
}

/** Append one startup notice to the seed; returns the entry so the caller
 *  can also collect notes-only copies. */
function noteEntry(event: string, detail?: string): LogEntry {
  return { kind: "notice", lines: noticeLine("notice", event, detail) };
}

/** The ` · ~N tokens in context` suffix when the dump carries a weight. */
function contextWeight(dump: TranscriptResult): number {
  let weight = finalContextTotal(dump.turns);
  if (weight <= 0) weight = estimatedContextTotal(dump.messages);
  return weight;
}

/**
 * Resume-or-create (PLAN §5.5 item 1): `--new` short-circuits everything
 * and forces a fresh session; then an explicit `--session <id>`; then the
 * stored `lastSessionId` from state.json; otherwise create. A resumable
 * id is validated with `reopen` and hydrated from the server transcript
 * (full dump, no pagination); a stale id (`unknown_session`) falls back
 * to a fresh session with a one-line note.
 */
export async function resolveSession(
  client: YogClient,
  requested: string | undefined,
): Promise<ResolvedSession> {
  const seed: LogEntry[] = [];
  const notes: LogEntry[] = [];
  const note = (event: string, detail?: string): void => {
    const entry = noteEntry(event, detail);
    seed.push(entry);
    notes.push(entry);
  };

  if (requested === undefined) {
    const id = await client.open();
    note("new session", id);
    return { resumedTokenWeight: 0, seed, notes };
  }

  let dump: TranscriptResult;
  try {
    const adopted = await client.reopen(requested);
    if (adopted === undefined) {
      throw new YogError("unknown_session", `session ${requested} not found`, 404);
    }
    dump = await client.getTranscript();
    const weight = contextWeight(dump);
    note(
      "session resumed",
      `${requested} · ${dump.messages.length} messages from server transcript` +
        (weight > 0 ? ` · ~${formatTokenTotal(weight)} tokens in context` : ""),
    );
  } catch (err) {
    if (!(err instanceof YogError) || err.code !== "unknown_session") throw err;
    // Stale id only: fall through to a fresh session below.
    note("session reset", `${requested} is gone — started fresh`);
    const id = await client.open();
    note("new session", id);
    return { resumedTokenWeight: 0, seed, notes };
  }

  // Placeholder-first rehydrate (#67): every transcript row gets a cheap
  // placeholder *now* (O(1) per row, no glamour), so the first frame
  // paints instantly. Real entries swap in bottom-up (last chunk first —
  // the part the user sees) via `driveRehydrate` after the terminal is
  // taken over.
  const transcriptEntries = toTranscriptEntries(dump.messages);
  for (const entry of placeholderLogEntries(transcriptEntries, process.stdout.columns ?? 80)) {
    seed.push(entry);
  }
  // Pick the LAST running row: the server's orchestrator-owned row is the
  // one stamped with events/messages/usage (any earlier adapter row is a
  // duplicate with none of those), and first-match would wait on the
  // wrong row forever.
  const running = [...(dump.turns ?? [])].reverse().find((t) => t.status === "running");
  void perTurnDeltas(dump.turns);
  return {
    runningTurnId: running?.turnId,
    dump,
    resumedTokenWeight: contextWeight(dump),
    seed,
    notes,
  };
}
