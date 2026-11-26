/**
 * The per-row rehydration steps: what ONE transcript row (and its
 * shapes, tried in the order the walk asks for them (the harness step
 * precedes the others because its call row is a synthetic whose result
 * carries the whole payload — the generic call step would render it as
 * an opaque result blob):
 *
 *   harnessStep — the synthetic `harness_notice` call/result pair:
 *                 plain notice lines (kind + body), never a blob
 *   callStep    — an assistant row with tool calls: the ⚙️ lines plus
 *                 the result rows that answer them (paired by
 *                 `toolCallId`, consumed so nothing double-emits)
 *   proseStep   — a user or pure-prose assistant row: one entry per run
 *                 of consecutive same-role rows (one logical message),
 *                 the whole-message copy stamp on the run's last row
 *   orphanStep  — a tool row no call claimed (its call row predates the
 *                 transcript): standalone ✅/❌ line, chunk on success
 *   systemStep  — anything else: the verbatim server text
 *
 * Pure data shaping — no store, no rendering. `rehydrate.ts` drives the
 * steps over the row list; the flat converter and the grouped walker
 * share them, which is why their outputs agree by construction.
 */
import { parseToolArgs } from "../client/index.ts";
import { tokenCountNote } from "./toolFormat.ts";
import { annotateToolCall, toolCallEntry, toolResultEntries } from "./toolEntries.ts";
import {
  decodeHarnessNotices,
  harnessNoticeEntries,
  isHarnessNoticeTool,
} from "./harnessNotice.ts";
import type { LogEntry } from "./entries.ts";
import {
  decodeResultContent,
  decodeToolCalls,
  decodeToolResult,
  type TranscriptEntry,
} from "./transcript.ts";
import type { HarnessNotice } from "./harnessNotice.ts";

/**
 * The consecutive run of pure-prose rows starting at `start` (user rows
 * or assistant rows with no tool calls), stopping at the first row that
 * is anything else (a tool-call row, a tool result, a turn marker).
 * `whole` is the joined text of the run — the whole-message copy text —
 * null for a lone row that carries no joinable message (a user prompt
 * is whole by itself; the caller handles that via its own rule).
 * Advancing the cursor past the whole run keeps the O(n) walk linear.
 */
function proseRunOf(
  entries: TranscriptEntry[],
  start: number,
): { length: number; whole: string | null } {
  const first = entries[start]!;
  if (first.role !== "assistant") return { length: 1, whole: null };
  const parts: string[] = [first.text];
  let n = 1;
  while (start + n < entries.length) {
    const next = entries[start + n]!;
    if (next.role !== "assistant" || decodeToolCalls(next.raw.toolCalls).length > 0) break;
    parts.push(next.text);
    n += 1;
  }
  // A single-row run is still a whole message (the live path stamps
  // every close-of-block, even a one-chunk one).
  return { length: n, whole: parts.join("\n\n") };
}

/** Stamp the tool-call id as the copy item id on a result entry group
 *  (args and result are one transcript item, so the result block copies
 *  under the same id as its call line). Notice entries are NOT copyable
 *  items and stay unstamped; an undefined id leaves the group uncopyable
 *  rather than inventing one. */
function stampResultCopy(entries: LogEntry[], id: string | undefined): LogEntry[] {
  if (id === undefined) return entries;
  for (const entry of entries) {
    if (entry.kind === "status" || entry.kind === "notice") continue;
    entry.copyIds = { itemId: id };
  }
  return entries;
}

/** Insert the built result entries after `anchor` in `out` (append when the
 *  anchor is gone — a caller may have dropped it). */
function insertAfterCall(out: LogEntry[], anchor: LogEntry, results: LogEntry[]): void {
  const at = out.indexOf(anchor);
  out.splice(at === -1 ? out.length : at + 1, 0, ...results);
}

/** The ✅/❌ standalone line for an orphan tool result (its call row
 *  predates the transcript). A failure shows nothing beyond the error
 *  itself — the ❌ line carries it, as with live calls. */
function orphanResultLine(label: string, ok: boolean, error?: string): LogEntry {
  return {
    kind: "tool",
    lines: [`${ok ? "✅" : "❌"} ${label}${ok ? "" : ` ${error ?? "failed"}`}`],
  };
}

/** One tool result row decoded and consumed by the open call at `id`. */
function consumeResult(
  call: { entry: LogEntry; name: string },
  raw: TranscriptEntry["raw"],
  cols: number,
): { results: LogEntry[]; hasValue: boolean } | undefined {
  const decoded = decodeToolResult(raw);
  annotateToolCall(call.entry, decoded.ok, decoded.error);
  if (!(decoded.ok && decoded.value !== undefined && decoded.value !== null)) return undefined;
  return {
    results: stampResultCopy(
      toolResultEntries(
        call.name,
        decoded.value,
        cols,
        tokenCountNote(raw.resultTokens, { estimated: true }),
      ),
      typeof raw.toolCallId === "string" ? raw.toolCallId : undefined,
    ),
    hasValue: true,
  };
}

/**
 * One walk step's output: the log entries for the row group starting at
 * `entries[i]`, and the index the walk should continue from.
 */
export interface Step {
  group: LogEntry[];
  next: number;
}

/**
 * The harness-notice step (server prelude pairs): the call row is the
 * synthetic `harness_notice` call (empty args); its result rows —
 * consumed through the same pairing — decode to plain notice lines
 * (kind label + dimmed body). Consuming the result here keeps the
 * call/result group one walk step, exactly like a tool call and its
 * result; the call line itself contributes nothing (all information
 * lives in the result). Returns undefined when the row is anything
 * else — including a harness call whose payload is missing or
 * malformed, which falls through to the generic call step (the ✅ line
 * plus the raw result block).
 */
function harnessStep(entries: TranscriptEntry[], i: number): Step | undefined {
  const e = entries[i]!;
  if (e.role !== "assistant") return undefined;
  const calls = decodeToolCalls(e.raw.toolCalls);
  const call = calls.length === 1 ? calls[0] : undefined;
  if (call === undefined || !isHarnessNoticeTool(call.name)) return undefined;
  const pair = consumeHarnessPair(entries, i, call.id);
  // A pair whose result does not decode is not ours to consume: fall
  // through to the generic call step (the ✅/❌ line plus the raw blob),
  // which re-pairs the same rows from scratch.
  if (pair === undefined) return undefined;
  const group = harnessNoticeEntries(pair.notices);
  // Copy identity: the attached result entries are the transcript item —
  // stamp them with the call id like every other paired result.
  return { group: stampResultCopy(group, call.id), next: pair.end };
}

/** True when row `j` is a tool result answering `callId` (the pairing
 *  boundary both consumers share). */
function isPairableToolRow(entries: TranscriptEntry[], j: number, callId: string): boolean {
  const next = entries[j];
  if (next === undefined) return false;
  return next.role === "tool" && next.raw.toolCallId === callId;
}

/** The paired result rows' notices and the walk's resume index. `undefined`
 *  when any result row fails to decode (the caller falls through to the
 *  generic call step, which re-pairs the same rows from scratch). */
function consumeHarnessPair(
  entries: TranscriptEntry[],
  i: number,
  callId: string,
): { notices: HarnessNotice[]; end: number } | undefined {
  const notices: HarnessNotice[] = [];
  let j = i + 1;
  while (isPairableToolRow(entries, j, callId)) {
    const decoded = decodeHarnessNotices(decodeResultContent(entries[j]!.raw.content).value);
    if (decoded === undefined) return undefined;
    notices.push(...decoded);
    j += 1;
  }
  return { notices, end: j };
}

/** The call+results step for an assistant row carrying tool calls: emits
 *  the ⚙️ lines, then consumes the matching tool result rows that follow
 *  (pairing via `toolCallId`, so a result without its call row stays for
 *  the orphan path). Returns undefined when the row is not a call row. */
function callStep(entries: TranscriptEntry[], i: number, cols: number): Step | undefined {
  const e = entries[i]!;
  if (e.role !== "assistant") return undefined;
  const calls = decodeToolCalls(e.raw.toolCalls);
  if (calls.length === 0) return undefined;
  const group: LogEntry[] = [];
  const open = new Map<string, { entry: LogEntry; name: string }>();
  for (const c of calls) {
    const entry = toolCallEntry(c.id, c.name, parseToolArgs(c.arguments), cols);
    entry.copyIds = { itemId: c.id };
    group.push(entry);
    open.set(c.id, { entry, name: c.name });
  }
  const j = consumeToolResults(entries, i + 1, open, group, cols);
  // Calls left without a result row keep their bare call line.
  return { group, next: j };
}

/** Consume the result rows that answer the open calls: each pairing
 *  annotates the call line and splices its result entries after it.
 *  Returns one past the last consumed row (the walk resumes there). */
function consumeToolResults(
  entries: TranscriptEntry[],
  start: number,
  open: Map<string, { entry: LogEntry; name: string }>,
  group: LogEntry[],
  cols: number,
): number {
  let j = start;
  while (j < entries.length) {
    const next = entries[j]!;
    const id = next.role === "tool" ? next.raw.toolCallId : undefined;
    if (id === undefined || !open.has(id)) break;
    const call = open.get(id);
    open.delete(id);
    const consumed = consumeResult(call!, next.raw, cols);
    if (consumed !== undefined) insertAfterCall(group, call!.entry, consumed.results);
    j += 1;
  }
  return j;
}

/** The prose step for a user or pure-prose assistant row: one entry per
 *  run of consecutive same-role rows (one logical message), with the
 *  whole-message copy stamp on the run's last row — the same rule the
 *  live path uses. Returns undefined when the row is not prose. */
function proseStep(entries: TranscriptEntry[], i: number): Step | undefined {
  const e = entries[i]!;
  if (e.role !== "user" && e.role !== "assistant") return undefined;
  // Copy identity: the transcript row seq is the item id. On an assistant
  // row with NO tool calls (pure prose), also stamp the whole-message
  // copy: the joined text of every consecutive prose row of the same
  // logical message (no tool row in between), on the LAST of those rows.
  const run = proseRunOf(entries, i);
  const group: LogEntry[] = [
    {
      kind: e.role,
      lines: [e.text],
      copyText: e.text,
      copyIds:
        run.whole === null
          ? { itemId: String(e.raw.seq) }
          : { itemId: String(e.raw.seq), wholeMessage: run.whole },
    },
  ];
  return { group, next: i + run.length };
}

/** The orphan-result step for a tool row no call line claimed: standalone
 *  ✅/❌ line, plus an output chunk on success only — the row's own token
 *  count rides its own result block. Returns undefined for other rows. */
function orphanStep(entries: TranscriptEntry[], i: number, cols: number): Step | undefined {
  const e = entries[i]!;
  if (e.role !== "tool") return undefined;
  const decoded = decodeToolResult(e.raw);
  const label = e.raw.name ?? e.raw.toolCallId ?? "tool";
  const orphanId = typeof e.raw.toolCallId === "string" ? e.raw.toolCallId : undefined;
  const group: LogEntry[] = [orphanResultLine(label, decoded.ok, decoded.error)];
  const last = group[0] as LogEntry;
  if (orphanId !== undefined) last.copyIds = { itemId: orphanId };
  if (decoded.ok && decoded.value !== undefined && decoded.value !== null) {
    group.push(
      ...stampResultCopy(
        toolResultEntries(
          label,
          decoded.value,
          cols,
          tokenCountNote(e.raw.resultTokens, { estimated: true }),
        ),
        orphanId,
      ),
    );
  }
  return { group, next: i + 1 };
}

/** The fallback step for any other row (rehydrated server-transcript
 *  system rows, the session prompt): keep the verbatim server text — it
 *  is transcript content, not a client event, so no notice decoration
 *  applies. */
function systemStep(entries: TranscriptEntry[], i: number): Step {
  return { group: [{ kind: "system", lines: [entries[i]!.text] }], next: i + 1 };
}

/** The step for row `i`: call+results, prose, orphan result, or system. */
export function stepFor(entries: TranscriptEntry[], i: number, cols: number): Step {
  return (
    harnessStep(entries, i) ??
    callStep(entries, i, cols) ??
    proseStep(entries, i) ??
    orphanStep(entries, i, cols) ??
    systemStep(entries, i)
  );
}
