/**
 * Turn presenter — SSE turn events → chat-log/transcript state updates.
 *
 * Pure event translation: no rendering, no terminal access. `main.ts` wires
 * the returned {@link TurnEvents} callbacks to the client and supplies the
 * column width for tool-line fitting. The pending tool-call pairing lives
 * here for the duration of a turn; the shared entry builders
 * (`toolCallEntry` / `annotateToolCall` / `toolResultChunk`) also serve
 * transcript rehydration, so restored rows render exactly like live ones.
 */
import { parseToolArgs, type TurnEvents } from "../yogClient.ts";
import { prettyArgs, resultPreview, resultStatus, type LogEntry } from "../ui/render/index.ts";
import { displayWidth } from "../util/ansi.ts";
import {
  decodeToolCalls,
  decodeToolResult,
  type TranscriptEntry,
} from "./transcript.ts";

/** Anything that can be pushed to the log and schedules a redraw. */
export type AppendEntry = (kind: LogEntry["kind"], lines: string[]) => void;

/** Presenter-facing slice of the shared UI state. */
export interface TurnHost {
  entries: LogEntry[];
  append: AppendEntry;
  /** Terminal width (columns) used to fit tool-call lines. */
  width: () => number;
  /** Schedule a redraw (coalesced by the render scheduler). */
  requestRender: () => void;
}

/** Mutable turn session handed to the client's `TurnEvents` handlers. */
export interface TurnPresenter {
  /** Chat-log mutations produced by the turn's events. */
  events: TurnEvents;
  /** User message + reset lines (spinner already started). */
  begin(input: string): void;
  /**
   * Turn finished: stop marking the assistant entry as streaming (the
   * server persists the turn; the client keeps no history).
   */
  finish(): void;
  /** A turn failed (non-ok outcome or thrown error): record the line. */
  fail(detail: string): void;
}

/** Create the presenter for one turn (one `submit()`). */
export function createTurnPresenter(host: TurnHost): TurnPresenter {
  // Tool call id → its log entry, so results can annotate the call line.
  const pendingToolCalls = new Map<string, LogEntry>();
  const assistant: { entry?: LogEntry } = {}; // holder avoids closure narrowing

  const events: TurnEvents = {
    onDelta: (text) => {
      // Invariant: a prose entry is only ever appended to while it is the
      // log tail. Tool calls close the open block eagerly (see onToolCall);
      // if anything else interposed (error/recovery note, orphan result
      // line), close it here too — re-pushing the shared object would make
      // every alias replay every later delta.
      if (
        assistant.entry !== undefined &&
        host.entries[host.entries.length - 1] !== assistant.entry
      ) {
        assistant.entry.streaming = false;
        assistant.entry = undefined;
      }
      const entry = (assistant.entry ??= { kind: "assistant", lines: [""], streaming: true });
      if (host.entries[host.entries.length - 1] !== entry) host.entries.push(entry);
      // Append to the last (possibly partial) paragraph, re-split on \n.
      const lines = entry.lines;
      const lastIdx = lines.length - 1;
      const merged = `${lines[lastIdx] ?? ""}${text}`;
      lines.splice(lastIdx, 1, ...merged.split("\n"));
      host.requestRender();
    },
    onToolCall: (id, name, args) => {
      // A tool call ends the open prose segment: close it on the spot so
      // any later prose streams into a fresh block of its own (the onDelta
      // tail guard below is the generic backstop).
      if (assistant.entry !== undefined) {
        assistant.entry.streaming = false;
        assistant.entry = undefined;
      }
      const entry = toolCallEntry(id, name, args, host.width());
      host.entries.push(entry);
      pendingToolCalls.set(id, entry);
      host.requestRender();
    },
    onToolResult: (id, name, ok, result, error) => {
      // Annotate the matching call line in place (no extra chat lines).
      const call = pendingToolCalls.get(id);
      if (call) {
        pendingToolCalls.delete(id);
        annotateToolCall(call, ok, error);
      } else {
        host.append(
          "tool",
          [`${ok ? "✅" : "❌"} ${name || "tool"}${ok ? "" : ` ${error ?? "failed"}`}`],
        );
      }
      // The result itself: a collapsible tool-output block. Only for
      // successful calls — a failed call (invalid schema, unknown tool)
      // has no stdout/stderr/exit data to show: the ❌ + error already on
      // the call line is the whole failure display.
      if (ok && result !== undefined && result !== null) {
        host.entries.push(toolResultChunk(name, result, host.width()));
      }
      host.requestRender();
    },
    onAborted: (reason) => {
      // The server's canonical reason restates the event ("turn aborted by
      // operator"); keep only the suffix that isn't already on the label.
      const trimmed = reason.replace(/^turn aborted\s*—?\s*/, "");
      host.append("notice", ["⏹️ turn aborted", trimmed]);
    },
    onError: (code, message) => {
      host.append("error", [`${code}: ${message}`]);
    },
    onRecovered: () => {
      host.append("system", ["stream interrupted — recovered from turn status"]);
    },
  };

  return {
    events,
    begin: (input) => {
      host.append("user", [input]);
      assistant.entry = undefined;
    },
    finish: () => {
      if (assistant.entry) assistant.entry.streaming = false;
    },
    fail: (detail) => {
      host.append("error", [detail]);
    },
  };
}

/**
 * Build a tool-call log entry — the ⚙️ call line with compact args and the
 * expandable full args. Shared by the live turn path and transcript
 * rehydration so rehydrated rows are the same rich entries a live turn
 * produces.
 */
export function toolCallEntry(id: string, name: string, args: unknown, cols: number): LogEntry {
  const label = `⚙️ ${name || "tool"}`;
  const full =
    args === undefined || args === null
      ? undefined
      : prettyArgs(args, Number.MAX_SAFE_INTEGER, "pretty");
  // The rebuilt row (label + ✅ + space + args + 2 padding) must fit
  // cols exactly: reserve 3 cells for the check landing in the label.
  const argsCompact =
    full === undefined
      ? undefined
      : prettyArgs(args, Math.max(12, cols - displayWidth(label) - 3 - 1 - 2));
  const shown = argsCompact === undefined ? label : `${label} ${argsCompact}`;
  return { kind: "tool", lines: [shown], label, argsCompact, full, expanded: false };
}

/**
 * Annotate a tool-call entry with its outcome: the ✅/❌ marker lands in the
 * label (before the args), keeping its position across collapse/expand, and
 * the collapsed line is rebuilt around it.
 */
export function annotateToolCall(call: LogEntry, ok: boolean, error?: string): void {
  const suffix = ok ? " ✅" : ` ❌ ${error ?? "failed"}`;
  if (call.label !== undefined) {
    call.label = `${call.label}${suffix}`;
    call.lines[0] =
      call.argsCompact === undefined ? call.label : `${call.label} ${call.argsCompact}`;
  } else {
    call.lines[0] = `${call.lines[0] ?? ""}${suffix}`;
  }
}

/**
 * Build the collapsible tool-output chunk for a result: the header carries
 * the tool name and status (`exit 0 · 42ms` when present); the body is []
 * for status-only results — short blocks render full height, long ones stay
 * collapsible. Shared by the live turn path and rehydration.
 */
export function toolResultChunk(name: string, result: unknown, cols: number): LogEntry {
  const body = resultPreview(result, cols);
  const status = resultStatus(result);
  const arrow = status ? ` → ${status}` : " →";
  return {
    kind: "chunk",
    lines: [`${name || "tool"}${arrow}`, ...body],
    collapsed: true,
  };
}

/**
 * Convert rehydrated transcript entries into chat-log entries, reusing the
 * live-turn builders: an assistant row carrying tool calls produces the same
 * ⚙️ call lines, annotated ✅/❌ by their matching tool result rows (paired
 * via `toolCallId`, consumed so nothing double-emits) followed by their
 * collapsible result chunks; plain user/assistant/system rows render as
 * their entry kinds. Orphan result rows (their call row predates the
 * transcript) render as a standalone ✅/❌ status line, plus an output
 * chunk on success only — a failure has no result data beyond the error
 * already shown on its line. Width-aware like the live path; never throws
 * on odd rows.
 */
export function transcriptLogEntries(entries: TranscriptEntry[], cols: number): LogEntry[] {
  const out: LogEntry[] = [];
  let i = 0;
  while (i < entries.length) {
    const e = entries[i]!;
    const calls = e.role === "assistant" ? decodeToolCalls(e.raw.toolCalls) : [];
    if (calls.length > 0) {
      const open = new Map<string, { entry: LogEntry; name: string }>();
      for (const c of calls) {
        const entry = toolCallEntry(c.id, c.name, parseToolArgs(c.arguments), cols);
        out.push(entry);
        open.set(c.id, { entry, name: c.name });
      }
      i += 1;
      // Consume the tool result rows that answer these calls.
      while (i < entries.length) {
        const next = entries[i]!;
        if (next.role !== "tool") break;
        const id = next.raw.toolCallId;
        if (id === undefined) break;
        const call = open.get(id);
        if (call === undefined) break;
        open.delete(id);
        const decoded = decodeToolResult(next.raw);
        annotateToolCall(call.entry, decoded.ok, decoded.error);
        if (decoded.ok && decoded.value !== undefined && decoded.value !== null) {
          out.push(toolResultChunk(call.name, decoded.value, cols));
        }
        i += 1;
      }
      // Calls left without a result row keep their bare call line.
      continue;
    }
    if (e.role === "user" || e.role === "assistant") {
      out.push({ kind: e.role, lines: [e.text] });
    } else if (e.role === "tool") {
      // Orphan result row (its call row predates the transcript). Success:
      // standalone status line + output chunk. Failure: nothing beyond the
      // error itself to show — the ❌ line carries it, as with live calls.
      const decoded = decodeToolResult(e.raw);
      const label = e.raw.name ?? e.raw.toolCallId ?? "tool";
      out.push({
        kind: "tool",
        lines: [`${decoded.ok ? "✅" : "❌"} ${label}${decoded.ok ? "" : ` ${decoded.error ?? "failed"}`}`],
      });
      if (decoded.ok && decoded.value !== undefined && decoded.value !== null) {
        out.push(toolResultChunk(label, decoded.value, cols));
      }
    } else {
      out.push({ kind: "system", lines: [e.text] });
    }
    i += 1;
  }
  return out;
}