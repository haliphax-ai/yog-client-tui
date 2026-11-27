/**
 * Transcript rehydration — server transcript rows → chat-log entries.
 *
 * Three public views over one walk:
 * - `transcriptLogEntries` — the full flat conversion (startup seed, poll
 *   refresh, post-compaction rebuild).
 * - `rehydrateGroups` — the same conversion, cut into per-transcript-row
 *   groups so the placeholder-first swapper (#67) can materialize the log
 *   bottom-up (the concatenation of groups in row order IS the flat
 *   conversion, by construction: both are driven by the same `walk`).
 * - `rehydrateGroupIndices` — which transcript rows each group covers, so
 *   the swapper knows which placeholders to remove.
 *
 * Assistant rows carrying tool calls pair with their result rows via
 * `toolCallId` (consumed so nothing double-emits); orphan results (their
 * call row predates the transcript) render as a standalone ✅/❌ line plus
 * an output chunk on success. Turn-boundary summaries (runtime · tool
 * calls · tokens) are emitted when the transcript moves to the next turn.
 *
 * Pure and terminal-free: `core` stays presentation-free; every width is
 * the caller's column count. Never throws on odd rows.
 */
import type { LogEntry } from "./entries.ts";
import { decodeToolCalls, type TranscriptEntry } from "./transcript.ts";
import { stepFor } from "./rehydrateSteps.ts";
import { TurnTracker, turnIdOf } from "./turnTracker.ts";
import type { TranscriptRehydrateOpts } from "./turnMetrics.ts";

/**
 * A wake turn's prompt row styles as `system` — harness-internal,
 * never user-typed. The substitution is a fresh-entry transform (1:1,
 * indices stable) applied ONCE, before either walker: the walk itself
 * stays wake-agnostic.
 */
function wakeSubstitute(
  entries: TranscriptEntry[],
  turns: TranscriptRehydrateOpts["turns"],
): TranscriptEntry[] {
  const wake = new Set<number>();
  for (const [id, m] of (turns ?? new Map()).entries()) {
    if (m.wake === true) wake.add(id);
  }
  if (wake.size === 0) return entries;
  return entries.map((e) =>
    e.role === "user" && wake.has(Number(e.raw.turnId)) ? { ...e, role: "system" } : e,
  );
}

export type { TranscriptRehydrateOpts, TranscriptTurnMetrics } from "./turnMetrics.ts";

/**
 * Convert rehydrated transcript entries into chat-log entries, reusing the
 * live-turn builders: an assistant row carrying tool calls produces the same
 * ⚙️ call lines, annotated ✅/❌ by their matching tool result rows, followed
 * by their collapsible result chunks; plain user/assistant/system rows render
 * as their entry kinds; orphan result rows render as a standalone ✅/❌
 * status line, plus an output chunk on success only. Width-aware like the
 * live path; never throws on odd rows.
 */
export function transcriptLogEntries(
  entries: TranscriptEntry[],
  cols: number,
  opts: TranscriptRehydrateOpts = {},
): LogEntry[] {
  const rows = wakeSubstitute(entries, opts.turns);
  const out: LogEntry[] = [];
  const tracker = new TurnTracker(opts.turns ?? new Map(), (entry) => out.push(entry));
  let i = 0;
  while (i < rows.length) {
    tracker.cross(turnIdOf(rows[i]!));
    const step = stepFor(rows, i, cols);
    tracker.countCalls(step.group.filter((e) => e.kind === "tool" && e.label !== undefined).length);
    out.push(...step.group);
    i = step.next;
  }
  tracker.finish();
  return out;
}

/**
 * Bottom-up rehydration (#67): build the real log entries for transcript
 * rows starting from the *last* chunk (the part the user actually sees)
 * and walk backwards, so the visible region materializes first. Each
 * group holds the real entries for one transcript row (expanding to
 * call/result/status rows exactly as `transcriptLogEntries` does for
 * that row group); the caller splices them in at the placeholder's
 * position. Grouping reuses the same pairing / orphan / turn-summary
 * logic as the full converter by construction: the concatenation of
 * groups in index order is exactly `transcriptLogEntries(entries, cols,
 * opts)`.
 */
export function rehydrateGroups(
  entries: TranscriptEntry[],
  cols: number,
  opts: TranscriptRehydrateOpts = {},
): LogEntry[][] {
  const rows = wakeSubstitute(entries, opts.turns);
  const groups: LogEntry[][] = [];
  // Turn summaries belong to the PREVIOUS turn's last row group; pending
  // holds them until the group that ends the turn exists.
  let pending: LogEntry[] = [];
  const tracker = new TurnTracker(opts.turns ?? new Map(), (entry) => pending.push(entry));
  let i = 0;
  while (i < rows.length) {
    tracker.cross(turnIdOf(rows[i]!));
    const group: LogEntry[] = [];
    // Attach the summary to the previous group (the turn that just ended);
    // before the first group, hold it — it will ride the first group's
    // predecessor slot via the same pending mechanism below.
    if (pending.length > 0) {
      const prev = groups[groups.length - 1];
      if (prev !== undefined) prev.push(...pending);
      else group.push(...pending);
      pending = [];
    }
    const step = stepFor(rows, i, cols);
    tracker.countCalls(step.group.filter((e) => e.kind === "tool" && e.label !== undefined).length);
    group.push(...step.group);
    groups.push(group);
    i = step.next;
  }
  // Final turn summary attaches to the last group (full converter parity).
  tracker.finish();
  if (pending.length > 0) {
    const last = groups[groups.length - 1];
    if (last !== undefined) last.push(...pending);
    else groups.push(pending);
  }
  return groups;
}

/**
 * Transcript indices covered by each rehydrate group: a tool-call group
 * covers its call row plus every consumed result row, so the swapper
 * knows which placeholders to remove when swapping one group; a pure-
 * prose run shares one group (it collapses into a single entry).
 */
/** The rows of the pure-prose run starting at `start` (already consumed its
 *  first row): consecutive assistant rows with no tool calls. */
function proseRunIndices(entries: TranscriptEntry[], start: number): number[] {
  const covered: number[] = [];
  let i = start;
  while (i < entries.length) {
    const next = entries[i]!;
    if (next.role !== "assistant" || decodeToolCalls(next.raw.toolCalls).length > 0) break;
    covered.push(i);
    i += 1;
  }
  return covered;
}

/** The result rows that answer the calls of one call row (already consumed
 *  its first row): each carries a `toolCallId` one of the calls is still
 *  waiting for; consumed ids are removed so nothing double-pairs. */
function consumedResultIndices(
  entries: TranscriptEntry[],
  start: number,
  callIds: readonly string[],
): number[] {
  const open = new Set(callIds);
  const covered: number[] = [];
  let i = start;
  while (i < entries.length) {
    const next = entries[i]!;
    if (next.role !== "tool") break;
    const id = next.raw.toolCallId;
    if (id === undefined || !open.has(id)) break;
    open.delete(id);
    covered.push(i);
    i += 1;
  }
  return covered;
}

export function rehydrateGroupIndices(entries: TranscriptEntry[]): number[][] {
  const idx: number[][] = [];
  let i = 0;
  while (i < entries.length) {
    const e = entries[i]!;
    const calls = e.role === "assistant" ? decodeToolCalls(e.raw.toolCalls) : [];
    i += 1;
    const rest =
      calls.length === 0 && e.role === "assistant"
        ? proseRunIndices(entries, i)
        : calls.length > 0
          ? consumedResultIndices(
              entries,
              i,
              calls.map((c) => c.id),
            )
          : [];
    idx.push([i - 1, ...rest]);
    i += rest.length;
  }
  return idx;
}
