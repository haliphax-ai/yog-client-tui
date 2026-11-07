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
import { parseToolArgs, type TurnEvents, type TokenUsage } from "../yogClient.ts";
import {
  formatRuntime,
  formatTokenTotal,
  prettyArgs,
  resultStatus,
  tokenCountNote,
  isBashShaped,
} from "./toolFormat.ts";
import { displayWidth } from "../util/ansi.ts";
import type { LogEntry } from "./entries.ts";
import { noticeLine } from "./notices.ts";
import { decodeToolCalls, decodeToolResult, type TranscriptEntry } from "./transcript.ts";

/** Per-turn metrics for a rehydrated turn (usage/duration as captured). */
export interface TranscriptTurnMetrics {
  usage?: TokenUsage;
  durationMs?: number;
}

/** Options for transcript rehydration entries. */
export interface TranscriptRehydrateOpts {
  /** Per-turn metrics, keyed by the transcript row's `turnId` (row id). */
  turns?: Map<number, TranscriptTurnMetrics>;
}

/** Turn-level total for a usage object (total field, else prompt+completion). */
function usageTotal(usage: TokenUsage | undefined): number {
  if (usage === undefined) return 0;
  if (typeof usage.total_tokens === "number") return usage.total_tokens;
  return (
    (typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0) +
    (typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0)
  );
}

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
  /**
   * The session token total before this turn ran (used to show the turn's
   * incremental tokens in the summary line). Omit to fall back to showing
   * the full reported total.
   */
  prevTokenTotal?: () => number;
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
  // Tool calls announced during this turn (reset per presenter = per turn).
  let toolCallsThisTurn = 0;

  const events: TurnEvents = {
    onDelta: (text) => {
      if (text.trim() === "") return;
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
      toolCallsThisTurn += 1;
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
    onToolResult: (id, name, ok, result, error, usage, promptDelta) => {
      // Annotate the matching call line in place (no extra chat lines).
      const call = pendingToolCalls.get(id);
      if (call) {
        pendingToolCalls.delete(id);
        annotateToolCall(call, ok, error);
        // THIS call's token count goes on THIS call's own result block — the
        // chunk/toolResult entries spliced right after the call line — never
        // on the call line itself (an args row showing a token figure reads
        // as the next call's attribution) and never on a later call's
        // block. Round-level bookkeeping (usage/promptDelta) stays off the
        // log here; the status bar owns it (live completion tokens are
        // folded into the session total as results land).
        // The delta/absolute distinction decides the `+` prefix:
        // promptDelta (+Nt) is context growth; completion tokens (Nt) are
        // the round's generation volume.
        const count = tokenCountNote(
          promptDelta ?? usage?.completion_tokens,
          promptDelta !== undefined,
        );
        if (ok && result !== undefined && result !== null) {
          const idx = host.entries.indexOf(call);
          const insertAt = idx !== -1 ? idx + 1 : host.entries.length;
          host.entries.splice(insertAt, 0, ...toolResultEntries(name, result, host.width(), count));
        }
      } else {
        host.append("tool", [
          `${ok ? "✅" : "❌"} ${name || "tool"}${ok ? "" : ` ${error ?? "failed"}`}`,
        ]);
        if (ok && result !== undefined && result !== null) {
          host.entries.push(
            ...toolResultEntries(
              name,
              result,
              host.width(),
              tokenCountNote(usage?.completion_tokens),
            ),
          );
        }
      }
      host.requestRender();
    },
    onAborted: (reason, usage) => {
      // The server's canonical reason restates the event ("turn aborted by
      // operator"); keep only the suffix that isn't already on the label.
      const trimmed = reason.replace(/^turn aborted\s*—?\s*/, "");
      // End-of-turn counts for an aborted turn (cut-point usage from the
      // server), mirroring the max_rounds notice's rich token breakdown.
      const tokenParts = usageTokenParts(usage);
      const detail =
        tokenParts.length > 0 ? `${trimmed} · tokens: ${tokenParts.join(" · ")}` : trimmed;
      host.append("notice", noticeLine("notice", "turn aborted", detail));
      // Per-turn summary line for parity with the normal/max_rounds finish
      // paths (no runtime: the abort envelope carries none).
      const summary: string[] = [
        `${toolCallsThisTurn} tool call${toolCallsThisTurn === 1 ? "" : "s"}`,
      ];
      if (usage !== undefined) {
        const absolute =
          typeof usage.total_tokens === "number"
            ? usage.total_tokens
            : (typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0) +
              (typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0);
        const prev = host.prevTokenTotal?.() ?? 0;
        const delta = Math.max(0, absolute - prev);
        if (delta > 0) summary.push(`${formatTokenTotal(delta)} tokens`);
      }
      host.append("status", [summary.join(" · ")]);
    },
    onError: (code, message) => {
      host.append("error", noticeLine("error", "turn error", `${code}: ${message}`));
    },
    onRecovered: () => {
      host.append(
        "notice",
        noticeLine("notice", "recovered", "stream interrupted — resumed from turn status"),
      );
    },
    onFinish: (durationMs, stopReason, usage) => {
      // The dark-grey per-turn summary below is the happy-path signal that the
      // turn finished; notices are reserved for terminations outside that path
      // (capped rounds), where the label is genuinely informative. A capped
      // turn keeps the rich token breakdown on the notice's detail line.
      const tokenParts = usageTokenParts(usage);
      if (stopReason === "max_rounds") {
        const detail = `reached the tool-round cap after ${Math.max(1, Math.round(durationMs / 1000))}s`;
        host.append(
          "notice",
          noticeLine(
            "notice",
            "turn stopped",
            tokenParts.length > 0 ? `${detail} · tokens: ${tokenParts.join(" · ")}` : detail,
          ),
        );
      }
      // Per-turn summary line: runtime · tool calls · tokens (abbreviated).
      // The tool-call total is for THIS turn only — each presenter is created
      // fresh per submit(), so the counter never leaks across turns; session
      // totals stay in the status bar.
      const summary: string[] = [`runtime ${formatRuntime(durationMs)}`];
      summary.push(`${toolCallsThisTurn} tool call${toolCallsThisTurn === 1 ? "" : "s"}`);
      if (usage !== undefined) {
        const absolute =
          typeof usage.total_tokens === "number"
            ? usage.total_tokens
            : (typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0) +
              (typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0);
        // The server reports the full hydrated-context total, not this turn's
        // contribution — show the delta against the session total before the
        // turn ran (baseline 0 when unknown/first).
        const prev = host.prevTokenTotal?.() ?? 0;
        const delta = Math.max(0, absolute - prev);
        if (delta > 0) summary.push(`${formatTokenTotal(delta)} tokens`);
      }
      host.append("status", [summary.join(" · ")]);
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
      host.append("error", noticeLine("error", "turn failed", detail));
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
 * Build the collapsible tool-output chunk for a result: the header carries the
 * tool name, status (`exit 0 · 42ms` when present), and this call's token
 * count (`172t` — the bash-output header the issue asks for). The body is
 * the RAW result — the renderer expands it to display rows at the current
 * width, so the domain never formats it. Shared by the live turn path and
 * rehydration.
 */
export function toolResultChunk(name: string, result: unknown, tokenNote = ""): LogEntry {
  const status = resultStatus(result);
  const suffix = tokenNote === "" ? status : status === "" ? tokenNote : `${status} · ${tokenNote}`;
  const arrow = suffix ? ` → ${suffix}` : " →";
  return {
    kind: "chunk",
    lines: [`${name || "tool"}${arrow}`],
    collapsed: true,
    result,
    tokenNote: tokenNote === "" ? undefined : tokenNote,
  };
}
/**
 * Generic tool-result component for tools without the bash-style output
 * component: a 🔚 block that looks like a tool call (purple, expandable)
 * and shows the result payload as JSON — collapsed/truncated by default,
 * focus + Enter expands the full result. Shared by the live path and
 * rehydration.
 */
export function toolResultEntry(
  name: string,
  result: unknown,
  cols: number,
  tokenNote = "",
): LogEntry {
  const label = `🔚 ${name || "tool"}`;
  const full =
    result === undefined || result === null
      ? undefined
      : prettyArgs(result, Number.MAX_SAFE_INTEGER, "pretty");
  const argsCompact =
    full === undefined
      ? undefined
      : prettyArgs(result, Math.max(12, cols - displayWidth(label) - 3 - 1 - 2));
  const shown = argsCompact === undefined ? label : `${label} ${argsCompact}`;
  return {
    kind: "toolResult",
    lines: [shown],
    label,
    argsCompact,
    full,
    expanded: false,
    result,
    tokenNote: tokenNote,
  };
}

/** This call's own status line (same format as the turn summary), or undefined. */
function toolResultSummary(result: unknown): string | undefined {
  const obj =
    result !== null && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : {};
  const parts: string[] = [];
  if (typeof obj["runtimeMs"] === "number") {
    parts.push(`runtime ${formatRuntime(obj["runtimeMs"] as number)}`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * The log entries produced for a successful tool result: bash-shaped results
 * keep the collapsible output chunk; any other tool renders as the generic
 * 🔚 result component with its own attached per-call status line.
 */
export function toolResultEntries(
  name: string,
  result: unknown,
  cols: number,
  tokenNote = "",
): LogEntry[] {
  if (isBashShaped(result)) return [toolResultChunk(name, result, tokenNote)];
  const entries: LogEntry[] = [toolResultEntry(name, result, cols, tokenNote)];
  const summary = toolResultSummary(result);
  if (summary !== undefined) entries.push({ kind: "status", lines: [summary] });
  return entries;
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
 * already shown on its line, and each result row's own token count rides
 * its own result block, never a neighboring call line. Width-aware like
 * the live path; never throws on odd rows.
 */
export function transcriptLogEntries(
  entries: TranscriptEntry[],
  cols: number,
  opts: TranscriptRehydrateOpts = {},
): LogEntry[] {
  const out: LogEntry[] = [];
  let i = 0;
  let activeTurnId: number | null = null;
  let turnCallCount = 0;

  /** Flush the previous turn's summary when its row group ends. */
  const maybeFlushTurn = (nextTurnId: number | null): void => {
    if (activeTurnId !== null && nextTurnId !== activeTurnId) {
      const metrics = opts.turns?.get(activeTurnId);
      if (
        metrics !== undefined &&
        (metrics.durationMs !== undefined || usageTotal(metrics.usage) > 0)
      ) {
        const parts: string[] = [];
        if (metrics.durationMs !== undefined) {
          parts.push(`runtime ${formatRuntime(metrics.durationMs)}`);
        }
        parts.push(`${turnCallCount} tool call${turnCallCount === 1 ? "" : "s"}`);
        const total = usageTotal(metrics.usage);
        if (total > 0) parts.push(`${formatTokenTotal(total)} tokens`);
        out.push({ kind: "status", lines: [parts.join(" · ")] });
      }
      turnCallCount = 0;
    }
    activeTurnId = nextTurnId;
  };

  while (i < entries.length) {
    const e = entries[i]!;
    // Transcript turn ids are the server's turn-row ids (numbers); tolerate
    // numeric strings and odd payloads defensively.
    const rawTurnId = e.raw.turnId;
    let turnId: number | null = null;
    if (typeof rawTurnId === "number") {
      turnId = rawTurnId;
    } else if (typeof rawTurnId === "string" && rawTurnId.trim() !== "") {
      const n = Number(rawTurnId);
      if (Number.isFinite(n)) turnId = n;
    }
    maybeFlushTurn(turnId);
    const calls = e.role === "assistant" ? decodeToolCalls(e.raw.toolCalls) : [];
    if (calls.length > 0) {
      turnCallCount += calls.length;
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
          const idx = out.indexOf(call.entry);
          const insertAt = idx !== -1 ? idx + 1 : out.length;
          out.splice(
            insertAt,
            0,
            ...toolResultEntries(
              call.name,
              decoded.value,
              cols,
              tokenCountNote(
                next.raw.promptDelta ?? next.raw.usage?.completion_tokens,
                next.raw.promptDelta !== undefined,
              ),
            ),
          );
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
      // error itself to show (the ❌ line carries it, as with live calls).
      // The row's own token count rides its own result block.
      const decoded = decodeToolResult(e.raw);
      const label = e.raw.name ?? e.raw.toolCallId ?? "tool";
      out.push({
        kind: "tool",
        lines: [
          `${decoded.ok ? "✅" : "❌"} ${label}${decoded.ok ? "" : ` ${decoded.error ?? "failed"}`}`,
        ],
      });
      if (decoded.ok && decoded.value !== undefined && decoded.value !== null) {
        out.push(
          ...toolResultEntries(
            label,
            decoded.value,
            cols,
            tokenCountNote(
              e.raw.promptDelta ?? e.raw.usage?.completion_tokens,
              e.raw.promptDelta !== undefined,
            ),
          ),
        );
      }
    } else {
      // Rehydrated server-transcript system rows (the session prompt): keep
      // the verbatim server text — it is transcript content, not a client
      // event, so no notice decoration applies.
      out.push({ kind: "system", lines: [e.text] });
    }
    i += 1;
  }
  maybeFlushTurn(null);
  return out;
}

/** Human-readable "N prompt · N completion · N total" segments for a terminal
 * notice (max_rounds stop / abort). Empty when the turn has no usage. */
function usageTokenParts(usage: TokenUsage | undefined): string[] {
  const parts: string[] = [];
  if (usage === undefined) return parts;
  if (typeof usage.prompt_tokens === "number")
    parts.push(`${formatTokens(usage.prompt_tokens)} prompt`);
  if (typeof usage.completion_tokens === "number")
    parts.push(`${formatTokens(usage.completion_tokens)} completion`);
  if (typeof usage.total_tokens === "number")
    parts.push(`${formatTokens(usage.total_tokens)} total`);
  return parts;
}

/** Format a token count with thousands separators for the per-turn notice. */
function formatTokens(value: number): string {
  return value.toLocaleString("en-US");
}
