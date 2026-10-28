/**
 * Turn presenter — SSE turn events → chat-log/transcript state updates.
 *
 * Pure event translation: no rendering, no terminal access. `main.ts` wires
 * the returned {@link TurnEvents} callbacks to the client and supplies the
 * column width for tool-line fitting. The pending tool-call pairing and the
 * client-side transcript history live here for the duration of a turn.
 */
import type { TurnEvents } from "../yogClient.ts";
import { prettyArgs, resultPreview, resultStatus, type LogEntry } from "../ui/render/index.ts";
import { displayWidth } from "../util/ansi.ts";
import type { HistoryMessage } from "./history.ts";

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
   * Turn finished: stop marking the assistant entry as streaming and append
   * the accumulated assistant text to the transcript (in that order — the
   * transcript sees the finalized state).
   */
  finish(): void;
  /** A turn failed (non-ok outcome or thrown error): record the line. */
  fail(detail: string): void;
}

/** Create the presenter for one turn (one `submit()`). */
export function createTurnPresenter(
  host: TurnHost,
  history: HistoryMessage[],
): TurnPresenter {
  // Tool call id → its log entry, so results can annotate the call line.
  const pendingToolCalls = new Map<string, LogEntry>();
  const assistant: { entry?: LogEntry } = {}; // holder avoids closure narrowing
  let assistantText = "";

  const events: TurnEvents = {
    onDelta: (text) => {
      assistantText += text;
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
      const cols = host.width();
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
      const entry: LogEntry = {
        kind: "tool",
        lines: [shown],
        label,
        argsCompact,
        full,
        expanded: false,
      };
      host.entries.push(entry);
      pendingToolCalls.set(id, entry);
      host.requestRender();
    },
    onToolResult: (id, name, ok, result, error) => {
      // Annotate the matching call line in place (no extra chat lines).
      const call = pendingToolCalls.get(id);
      if (call) {
        pendingToolCalls.delete(id);
        const suffix = ok ? " ✅" : ` ❌ ${error ?? "failed"}`;
        // Check goes into the label (before the args), keeping its position
        // across collapse/expand; rebuild the collapsed line around it.
        if (call.label !== undefined) {
          call.label = `${call.label}${suffix}`;
          call.lines[0] =
            call.argsCompact === undefined
              ? call.label
              : `${call.label} ${call.argsCompact}`;
        } else {
          call.lines[0] = `${call.lines[0] ?? ""}${suffix}`;
        }
      } else {
        host.append(
          "tool",
          [`${ok ? "✅" : "❌"} ${name || "tool"}${ok ? "" : ` ${error ?? "failed"}`}`],
        );
      }
      // The result itself: a tool-output block. Header carries the status
      // (one space after the arrow); body is [] for status-only results —
      // short blocks render full height, long ones stay collapsible.
      if (result !== undefined && result !== null) {
        const cols = host.width();
        const body = resultPreview(result, cols);
        const status = resultStatus(result);
        const arrow = status ? ` → ${status}` : " →";
        host.entries.push({
          kind: "chunk",
          lines: [`${name || "tool"}${arrow}`, ...body],
          collapsed: true,
        });
      }
      host.requestRender();
    },
    onError: (code, message) => {
      host.append("error", [`${code}: ${message}`]);
    },
    onRecovered: () => {
      host.append("system", ["stream interrupted — turn recovered from turn status"]);
    },
  };

  return {
    events,
    begin: (input) => {
      history.push({ role: "user", text: input });
      host.append("user", [input]);
      assistant.entry = undefined;
      assistantText = "";
    },
    finish: () => {
      if (assistant.entry) assistant.entry.streaming = false;
      if (assistantText !== "") history.push({ role: "assistant", text: assistantText });
    },
    fail: (detail) => {
      host.append("error", [detail]);
    },
  };
}