/**
 * Client-side debug chunks (`YOG_DEBUG=1`) and the key logger
 * (`YOG_DEBUG_KEYS=1` or a path). Debug chunks appear only when
 * `YOG_DEBUG=1`; the key logger adds `key`/`char`/`paste` diagnostics to the
 * debug chunk stream and, when `YOG_DEBUG_KEYS` is a file path, appends a hex
 * dump of every raw input chunk to that file as well.
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
 * Key logger opt-in (`YOG_DEBUG_KEYS`): `1` (or any truthy marker) appends
 * the key diagnostics to the debug chunk only; a path appends them to the
 * debug chunk AND a hex dump of every raw input chunk to that file. Empty or
 * unset means the key logger is off. Gating on `isDebugEnabled()` happens at
 * the emit site, so `YOG_DEBUG_KEYS` alone stays inert.
 */
export function keyLogPath(): string | undefined {
  const keyEnv = process.env.YOG_DEBUG_KEYS;
  if (keyEnv === undefined || keyEnv === "") return undefined;
  return keyEnv === "1" ? "/tmp/yog-client-keys.log" : keyEnv;
}

/**
 * Whether key diagnostics (`key`/`char`/`paste`) should be emitted at all:
 * the key logger is opted in via `YOG_DEBUG_KEYS` AND debug chunks are on
 * (`YOG_DEBUG=1`) — the chunk gate decides visibility, so `YOG_DEBUG_KEYS`
 * alone never produces output.
 */
export function isKeyLogEnabled(): boolean {
  return keyLogPath() !== undefined && isDebugEnabled();
}
/** File sink for key-logger hex dumps (wired by `main`); null until set. */
export let onKeyDump: ((raw: string) => void) | undefined;

/** Wire (or clear) the key-logger file sink. */
export function setKeyDumpSink(sink: ((raw: string) => void) | undefined): void {
  onKeyDump = sink;
}

/**
 * Append client-side debug messages to the chat log. A no-op unless
 * `YOG_DEBUG=1`. When the entry is key diagnostics and the key logger is
 * opted in via `YOG_DEBUG_KEYS=<path>`, `raw` (the raw input chunk) is
 * hex-dumped to that file first — the caller performs the filesystem write,
 * since `ui/` is fs-confined. Consecutive calls merge into one debug chunk;
 * a non-debug entry between calls starts a fresh chunk.
 */
export function emitDebug(lines: readonly string[], raw?: string): void {
  if (!isDebugEnabled()) return;
  if (lines.length === 0) return;
  if (raw !== undefined) onKeyDump?.(raw);
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
