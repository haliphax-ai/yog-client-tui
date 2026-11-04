/**
 * Client-side debug chunks (`YOG_DEBUG=1`).
 *
 * Debug messages are appended to the chat log as a single collapsible
 * "debug" chunk (mirroring tool-result chunks: focusable, collapsed to
 * `COLLAPSE_LINES` rows by default, expandable via focus + Enter).
 *
 * Grouping: consecutive debug messages append to the SAME chunk. The group
 * closes as soon as a non-debug entry lands in the log — the next debug
 * message then opens a fresh chunk. This keeps a burst of diagnostics (for
 * example a run of keystrokes) in one revealable block instead of flooding
 * the log with one entry per message.
 *
 * The chunk is client-side only: it is never sent to the server and never
 * stored in the session transcript.
 */
import { getState, setState } from "../core/store.ts";
import type { LogEntry } from "../core/entries.ts";
import { noteMutation } from "./render/index.ts";

/** Header line of a debug chunk (carries the `→` collapse affordance). */
export const DEBUG_HEADER = "🐞 debug →";

/** Whether the client-side debug log is enabled (YOG_DEBUG=1). */
export function isDebugEnabled(): boolean {
  return process.env.YOG_DEBUG === "1";
}

/**
 * Append client-side debug messages to the chat log. A no-op unless
 * `YOG_DEBUG=1`. Consecutive calls merge into one debug chunk; a
 * non-debug entry between calls starts a fresh chunk.
 */
export function emitDebug(lines: readonly string[]): void {
  if (!isDebugEnabled()) return;
  if (lines.length === 0) return;
  const state = getState();
  const entries = state.entries;
  const last = entries[entries.length - 1];
  if (last !== undefined && last.kind === "debug") {
    last.lines.push(...lines);
    noteMutation(last);
    setState({ entries });
    return;
  }
  const entry: LogEntry = {
    kind: "debug",
    lines: [DEBUG_HEADER, ...lines],
    collapsed: true,
  };
  entries.push(entry);
  noteMutation(entry);
  setState({ entries });
}
