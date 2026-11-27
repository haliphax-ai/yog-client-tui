/**
 * Placeholder entries for the placeholder-first rehydrate (#67): one cheap
 * stand-in per transcript row, rendered immediately so the first frame
 * paints without any glamour pass; the real entries swap in bottom-up as
 * rehydration completes.
 *
 * Shapes follow the issue: `user: <truncated prompt>`, `agent: <truncated
 * response>`, `tool: <name>` (no args), `result: <name>` (no content),
 * `system: <truncated text>` for anything else. A wake turn's prompt row
 * is the exception: its placeholder is the same ONE quiet line the
 * `wakePromptStep` swap renders — the verbatim block is model-food whose
 * results sit on the synthetic pairs before it, so neither stage shows
 * it (#144). Truncation is cell-based (`truncateAnsi` on the plain text,
 * the label prefix measured in cells) so emoji never corrupts the budget
 * — see AGENTS.md. One placeholder may expand to several log entries on
 * swap (a tool-call row becomes a call line + result chunk); the swapper
 * maps by transcript index, not by log index.
 */
import { displayWidth, truncateAnsi } from "../util/index.ts";
import type { LogEntry } from "./entries.ts";
import { noticeLine } from "./notices.ts";
import { decodeToolCalls, type TranscriptEntry } from "./transcript.ts";

/** True when the row's text is the wake prompt's header line: the block
 *  the jobs manager builds for the model ([background jobs] N finished:
 *  results are attached below. …). One call, exact prefix — a user
 *  quoting the header mid-sentence renders as it always did. Shared with
 *  the swap-side step (`rehydrateSteps.ts`) so BOTH stages of the
 *  placeholder-first rehydrate (#67) agree on what collapses. */
export function isWakePromptText(text: string): boolean {
  return text.startsWith("[background jobs] ");
}

/** The one-line wake-prompt label shared with the swap-side step: the
 *  job count from the header when it parses, "delivered" otherwise. */
export function wakePromptLabel(text: string): string {
  const m = /^\[background jobs\] (\d+) finished/.exec(text);
  const label = m === null ? "background jobs delivered" : `background jobs: ${m[1]} delivered`;
  return noticeLine("notice", "background jobs", label).join(" · ");
}

/** The wake-prompt notice's DETAIL half (the part after the label): the
 *  count when the header parses, "delivered" on an unparsable shape. The
 *  swap-side step composes its noticeLine with this so both stages show
 *  the same words. */
export function wakePromptDetail(text: string): string {
  const m = /^\[background jobs\] (\d+) finished/.exec(text);
  return m === null ? "delivered" : `${m[1]} delivered`;
}

/** The system-row placeholder: a wake turn's prompt collapses to its one
 *  quiet line — never a placeholder of the verbatim block (#144). */
function systemPlaceholder(text: string, cols: number): LogEntry {
  if (isWakePromptText(text)) {
    return { kind: "placeholder", placeholderRole: "system", lines: [wakePromptLabel(text)] };
  }
  return placeholder(SHAPES.system, "system", text, cols);
}

/**
 * The wake-prompt step for the transcript walk (`rehydrateSteps.ts`
 * imports it alongside its own steps): a wake turn's prompt row — the
 * server's verbatim delivery block, up to hundreds of lines of
 * model-food — renders as ONE quiet harness line. Every result the block
 * names is already on the synthetic `call_bg_` pairs immediately before
 * it; the same rows re-rendered the block verbatim on every resume and
 * every tail sync, a 100+ row cyan wall (#144). The transcript itself
 * keeps the verbatim text (the model needs it); DISPLAY only.
 *
 * The step lives here with the seed-side predicate and label so both
 * rehydrate stages (#67) read from ONE definition of what collapses.
 */
export function wakePromptStep(
  entries: readonly { role: string; text: string }[],
  i: number,
): { group: [LogEntry, ...LogEntry[]]; next: number } | undefined {
  const e = entries[i];
  if (e === undefined || e.role !== "system" || !isWakePromptText(e.text)) return undefined;
  return {
    group: [
      {
        kind: "notice",
        harness: true,
        lines: noticeLine("notice", "background jobs", wakePromptDetail(e.text)),
      },
    ],
    next: i + 1,
  };
}

/** One placeholder shape: the role label it shows and its prefix. */
interface Shape {
  prefix: string;
}

/** The per-role placeholder shapes, in the order the roles are decided. */
const SHAPES = {
  user: { prefix: "user: " },
  tool: { prefix: "tool: " },
  agent: { prefix: "agent: " },
  result: { prefix: "result: " },
  system: { prefix: "system: " },
} as const satisfies Record<string, Shape>;

/** The row's one-line text: every whitespace run collapsed, trimmed. */
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Fit `body` after `prefix` inside the cell budget: truncate the body in
 *  cells (never characters — an emoji is two cells), and trim the prefix
 *  when the budget cannot even hold it. */
function fit(prefix: string, body: string, budget: number): string {
  const room = Math.max(8, budget - displayWidth(prefix));
  const short =
    displayWidth(body) > room ? (room >= 2 ? `${truncateAnsi(body, room - 1)}…` : "") : body;
  return short === "" ? prefix.trimEnd() : `${prefix}${short}`;
}

/** Build the placeholder entry for one row's role shape and text. */
function placeholder(
  shape: Shape,
  placeholderRole: LogEntry["placeholderRole"],
  body: string,
  cols: number,
): LogEntry {
  return {
    kind: "placeholder",
    placeholderRole,
    lines: [fit(shape.prefix, body, Math.max(24, cols - 2))],
  };
}

/**
 * One cheap placeholder per transcript entry (#67), chosen by role:
 * assistant rows with tool calls show the tool names; everything else
 * shows its text (tool rows their name/id).
 */
export function placeholderForTranscriptEntry(entry: TranscriptEntry, cols: number): LogEntry {
  const text = oneLine(entry.text);
  if (entry.role === "user") return placeholder(SHAPES.user, "user", text, cols);
  if (entry.role === "tool") {
    const name = entry.raw.name ?? entry.raw.toolCallId ?? "tool";
    return placeholder(SHAPES.result, "result", name || "tool", cols);
  }
  if (entry.role === "assistant") {
    const calls = decodeToolCalls(entry.raw.toolCalls);
    if (calls.length > 0) {
      const names = calls.map((c) => c.name || "tool").join(", ");
      return placeholder(SHAPES.tool, "tool", names, cols);
    }
    return placeholder(SHAPES.agent, "assistant", text, cols);
  }
  return systemPlaceholder(text, cols);
}

/** Every transcript row as a placeholder, in transcript order. */
export function placeholderLogEntries(entries: TranscriptEntry[], cols: number): LogEntry[] {
  return entries.map((e) => placeholderForTranscriptEntry(e, cols));
}
