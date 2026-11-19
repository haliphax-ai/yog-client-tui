/**
 * Placeholder entries for the placeholder-first rehydrate (#67): one cheap
 * stand-in per transcript row, rendered immediately so the first frame
 * paints without any glamour pass; the real entries swap in bottom-up as
 * rehydration completes.
 *
 * Shapes follow the issue: `user: <truncated prompt>`, `agent: <truncated
 * response>`, `tool: <name>` (no args), `result: <name>` (no content),
 * `system: <truncated text>` for anything else. Truncation is cell-based
 * (`truncateAnsi` on the plain text, the label prefix measured in cells)
 * so emoji never corrupts the budget — see AGENTS.md. One placeholder
 * may expand to several log entries on swap (a tool-call row becomes a
 * call line + result chunk); the swapper maps by transcript index, not
 * by log index.
 */
import { displayWidth, truncateAnsi } from "../util/ansi.ts";
import type { LogEntry } from "./entries.ts";
import { decodeToolCalls, type TranscriptEntry } from "./transcript.ts";

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
  return placeholder(SHAPES.system, "system", text, cols);
}

/** Every transcript row as a placeholder, in transcript order. */
export function placeholderLogEntries(entries: TranscriptEntry[], cols: number): LogEntry[] {
  return entries.map((e) => placeholderForTranscriptEntry(e, cols));
}
