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
  compactArgs,
  formatRuntime,
  formatDuration,
  formatTokenTotal,
  prettyArgs,
  resultStatus,
  tokenCountNote,
  isBashShaped,
} from "./toolFormat.ts";
import { displayWidth, truncateAnsi } from "../util/ansi.ts";
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
   * The next transcript message seq (the item id a user prompt will
   * carry once the server persists it). The presenter stamps it on the
   * user entry so copy identity (#109) matches rehydrated rows.
   */
  nextMessageSeq: () => string;
  /**
   * The session token total before this turn ran (used to show the turn's
   * incremental tokens in the summary line). Omit to fall back to showing
   * the full reported total.
   */
  prevTokenTotal?: () => number;
  /**
   * Called at most once per round, with the round's real promptDelta, when
   * the round's LAST tool result lands — so live session totals fold each
   * round in exactly once, even for batches.
   */
  onRoundDelta?(delta: number): void;
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
  const assistant: { entry?: LogEntry; whole?: string } = {}; // holder avoids closure narrowing
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
      // Copy snapshot: keep the verbatim delta so C copies the raw
      // Markdown even while the entry is still streaming. The whole-
      // message text accumulates across the logical message's chunks.
      entry.copyText = `${entry.copyText ?? ""}${text}`;
      assistant.whole = `${assistant.whole ?? ""}${text}`;
      host.requestRender();
    },
    onToolCall: (id, name, args) => {
      toolCallsThisTurn += 1;
      // A tool call ends the open prose segment: close it on the spot so
      // any later prose streams into a fresh block of its own (the onDelta
      // tail guard below is the generic backstop).
      if (assistant.entry !== undefined) {
        assistant.entry.streaming = false;
        // Close-of-block copy stamp: the prose chunk keeps its own
        // raw-delta copyText; the whole-message text rides the LAST chunk
        // of the logical message so Shift+C copies everything so far.
        assistant.entry.copyIds = {
          itemId: assistant.entry.copyIds?.itemId ?? "",
          wholeMessage: assistant.whole,
        };
        assistant.entry = undefined;
      }
      const entry = toolCallEntry(id, name, args, host.width());
      entry.copyIds = { itemId: id };
      host.entries.push(entry);
      pendingToolCalls.set(id, entry);
      host.requestRender();
    },
    onToolResult: (id, name, ok, result, error, usage, promptDelta, resultTokens) => {
      // Annotate the matching call line in place (no extra chat lines).
      const call = pendingToolCalls.get(id);
      if (call) {
        pendingToolCalls.delete(id);
        annotateToolCall(call, ok, error);
        // The last result of a round drains the pending map — the one place
        // the round's REAL promptDelta folds into live session totals, so a
        // batch never counts its round more than once.
        const lastOfRound = pendingToolCalls.size === 0;
        if (lastOfRound && promptDelta !== undefined) host.onRoundDelta?.(promptDelta);
        // THIS call's token count is the per-result tokenx estimate (~N tok)
        // from the server — no fallbacks: pre-release, the server always
        // sends resultTokens. Round-level real numbers (promptDelta) fold
        // into session totals once via onRoundDelta.
        const count = tokenCountNote(resultTokens, { estimated: true });
        if (ok && result !== undefined && result !== null) {
          const idx = host.entries.indexOf(call);
          const insertAt = idx !== -1 ? idx + 1 : host.entries.length;
          const results = toolResultEntries(name, result, host.width(), count);
          // Results copy identity: the tool-call id is the item id
          // — args and result are one transcript item.
          for (const resultEntry of results) {
            if (resultEntry.kind === "status") continue; // not a copyable item
            resultEntry.copyIds = { itemId: id };
          }
          host.entries.splice(insertAt, 0, ...results);
        }
      } else {
        host.append("tool", [
          `${ok ? "✅" : "❌"} ${name || "tool"}${ok ? "" : ` ${error ?? "failed"}`}`,
        ]);
        if (ok && result !== undefined && result !== null) {
          const results = toolResultEntries(
            name,
            result,
            host.width(),
            tokenCountNote(resultTokens, { estimated: true }),
          );
          // Orphan-result copy identity: the call id is the item id.
          for (const resultEntry of results) {
            if (resultEntry.kind === "status") continue; // not a copyable item
            resultEntry.copyIds = { itemId: id };
          }
          host.entries.push(...results);
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
    },
    onRateLimited: (info) => {
      host.append(
        "notice",
        noticeLine(
          "notice",
          "warning",
          `too many requests/tokens, backing off ${formatDuration(info.delayMs, true)}`,
        ),
      );
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
      // Copy identity (#109): the prompt is the transcript item — the
      // server assigns the next message seq, and the item id rides the
      // entry; the raw prompt text doubles as the copy snapshot.
      const entry: LogEntry = { kind: "user", lines: [input], copyText: input };
      entry.copyIds = { itemId: host.nextMessageSeq() };
      host.entries.push(entry);
      assistant.entry = undefined;
    },
    finish: () => {
      if (assistant.entry) {
        assistant.entry.streaming = false;
        // Final close-of-block stamp: the whole-message text rides
        // the last prose chunk so Shift+C copies the entire message.
        assistant.entry.copyIds = {
          itemId: assistant.entry.copyIds?.itemId ?? "",
          wholeMessage: assistant.whole,
        };
      }
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
export function toolCallEntry(_id: string, name: string, args: unknown, _cols: number): LogEntry {
  const label = `⚙️ ${name || "tool"}`;
  const full =
    args === undefined || args === null
      ? undefined
      : prettyArgs(args, Number.MAX_SAFE_INTEGER, "pretty");
  const argsCompact = full === undefined ? undefined : compactArgs(args);
  const shown = argsCompact === undefined ? label : `${label} ${argsCompact}`;
  // Copy snapshot: keep the verbatim args JSON so the copy path
  // (core/copyText) can apply the tool's own copy semantics; `copyIds`
  // is stamped by the caller (live turn / rehydration), which owns ids.
  return {
    kind: "tool",
    lines: [shown],
    label,
    argsCompact,
    full,
    expanded: false,
    argsRaw:
      typeof args === "string"
        ? args
        : args === undefined || args === null
          ? undefined
          : JSON.stringify(args),
  };
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
    // Copy snapshot: keep the verbatim result JSON alongside the
    // raw payload so the copy path can apply the tool's own semantics.
    argsRaw: typeof result === "string" ? result : JSON.stringify(result),
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
  _cols: number,
  tokenNote = "",
): LogEntry {
  const label = `🔚 ${name || "tool"}`;
  const full =
    result === undefined || result === null
      ? undefined
      : prettyArgs(result, Number.MAX_SAFE_INTEGER, "pretty");
  const argsCompact = full === undefined ? undefined : compactArgs(result);
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
    // Copy snapshot: keep the verbatim result JSON (see
    // toolResultChunk).
    argsRaw: typeof result === "string" ? result : JSON.stringify(result),
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

/** Stamp the tool-call id as the copy item id on a result entry group
 *  args and result are one transcript item, so the result block
 *  copies under the same id as its call line. Status lines are not
 *  copyable items and stay unstamped; an undefined id leaves the group
 *  uncopyable rather than inventing one. */
function stampResultCopy(entries: LogEntry[], id: string | undefined): LogEntry[] {
  if (id === undefined) return entries;
  for (const entry of entries) {
    if (entry.kind === "status") continue;
    entry.copyIds = { itemId: id };
  }
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
        entry.copyIds = { itemId: c.id };
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
            ...stampResultCopy(
              toolResultEntries(
                call.name,
                decoded.value,
                cols,
                tokenCountNote(next.raw.resultTokens, { estimated: true }),
              ),
              id,
            ),
          );
        }
        i += 1;
      }
      // Calls left without a result row keep their bare call line.
      continue;
    }
    if (e.role === "user" || e.role === "assistant") {
      // Copy identity: the transcript row seq is the item id.
      out.push({
        kind: e.role,
        lines: [e.text],
        copyText: e.text,
        copyIds: { itemId: String(e.raw.seq) },
      });
    } else if (e.role === "tool") {
      // Orphan result row (its call row predates the transcript). Success:
      // standalone status line + output chunk. Failure: nothing beyond the
      // error itself to show (the ❌ line carries it, as with live calls).
      // The row's own token count rides its own result block.
      const decoded = decodeToolResult(e.raw);
      const label = e.raw.name ?? e.raw.toolCallId ?? "tool";
      const orphanLine: LogEntry = {
        kind: "tool",
        lines: [
          `${decoded.ok ? "✅" : "❌"} ${label}${decoded.ok ? "" : ` ${decoded.error ?? "failed"}`}`,
        ],
      };
      const orphanId = typeof e.raw.toolCallId === "string" ? e.raw.toolCallId : undefined;
      if (orphanId !== undefined) orphanLine.copyIds = { itemId: orphanId };
      out.push(orphanLine);
      if (decoded.ok && decoded.value !== undefined && decoded.value !== null) {
        out.push(
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

/**
 * One cheap placeholder per transcript entry (#67): rendered immediately
 * for every row, then swapped for the real entry as rehydration
 * completes. Shapes follow the issue: `user: <truncated prompt>`,
 * `agent: <truncated response>`, `tool: <name>` (no args),
 * `result: <name>` (no content), `system: <truncated text>` for
 * anything else. Truncation is cell-based (`truncateAnsi` on the
 * plain text, then the label prefix is measured in cells) so emoji
 * never corrupts the budget — see AGENTS.md. One placeholder may
 * expand to several log entries on swap (a tool-call row becomes a
 * call line + result chunk); the swapper maps by transcript index,
 * not by log index.
 */
export function placeholderForTranscriptEntry(entry: TranscriptEntry, cols: number): LogEntry {
  const budget = Math.max(24, cols - 2);
  const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
  const fit = (prefix: string, body: string): string => {
    const room = Math.max(8, budget - displayWidth(prefix));
    const short =
      displayWidth(body) > room ? (room >= 2 ? `${truncateAnsi(body, room - 1)}…` : "") : body;
    return short === "" ? prefix.trimEnd() : `${prefix}${short}`;
  };
  if (entry.role === "user") {
    return {
      kind: "placeholder",
      placeholderRole: "user",
      lines: [fit("user: ", oneLine(entry.text))],
    };
  }
  if (entry.role === "assistant") {
    const calls = decodeToolCalls(entry.raw.toolCalls);
    if (calls.length > 0) {
      const names = calls.map((c) => c.name || "tool").join(", ");
      return {
        kind: "placeholder",
        placeholderRole: "tool",
        lines: [fit("tool: ", names)],
      };
    }
    return {
      kind: "placeholder",
      placeholderRole: "assistant",
      lines: [fit("agent: ", oneLine(entry.text))],
    };
  }
  if (entry.role === "tool") {
    const name = entry.raw.name ?? entry.raw.toolCallId ?? "tool";
    return {
      kind: "placeholder",
      placeholderRole: "result",
      lines: [fit("result: ", name || "tool")],
    };
  }
  return {
    kind: "placeholder",
    placeholderRole: "system",
    lines: [fit("system: ", oneLine(entry.text))],
  };
}

/** Every transcript row as a placeholder, in transcript order. */
export function placeholderLogEntries(entries: TranscriptEntry[], cols: number): LogEntry[] {
  return entries.map((e) => placeholderForTranscriptEntry(e, cols));
}

/**
 * Bottom-up rehydration (#67): build the real log entries for transcript
 * rows starting from the *last* chunk (the part the user actually sees)
 * and walk backwards, so the visible region materializes first. Each
 * step returns the real entries for one transcript row (expanding to
 * call/result/status rows exactly as `transcriptLogEntries` does for
 * that row group); `spliceInto` inserts them at the placeholder's
 * position. The caller drives this in batches (e.g. one row per frame
 * via the scheduler) and paints placeholders in between.
 *
 * Implementation: precompute the full `transcriptLogEntries` result in
 * per-transcript-index groups via `rehydrateGroups`, then emit groups
 * from the last index backwards. Grouping reuses the same pairing /
 * orphan / turn-summary logic as the full converter by construction:
 * the concatenation of groups in index order is exactly
 * `transcriptLogEntries(entries, cols, opts)`.
 */
export function rehydrateGroups(
  entries: TranscriptEntry[],
  cols: number,
  opts: TranscriptRehydrateOpts = {},
): LogEntry[][] {
  const groups: LogEntry[][] = [];
  let i = 0;
  let activeTurnId: number | null = null;
  let turnCallCount = 0;
  let pendingSummary: LogEntry[] = [];
  const flushTurn = (nextTurnId: number | null): void => {
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
        pendingSummary.push({ kind: "status", lines: [parts.join(" · ")] });
      }
      turnCallCount = 0;
    }
    activeTurnId = nextTurnId;
  };
  while (i < entries.length) {
    const group: LogEntry[] = [];
    const e = entries[i]!;
    const rawTurnId = e.raw.turnId;
    let turnId: number | null = null;
    if (typeof rawTurnId === "number") turnId = rawTurnId;
    else if (typeof rawTurnId === "string" && rawTurnId.trim() !== "") {
      const n = Number(rawTurnId);
      if (Number.isFinite(n)) turnId = n;
    }
    // Turn summary belongs to the *previous* turn's last row group; keep
    // it aligned with the full converter by appending it there.
    flushTurn(turnId);
    if (pendingSummary.length > 0) {
      // Attach to the previous group (the turn that just ended).
      const prev = groups[groups.length - 1];
      if (prev !== undefined) prev.push(...pendingSummary);
      else group.push(...pendingSummary);
      pendingSummary = [];
    }
    const calls = e.role === "assistant" ? decodeToolCalls(e.raw.toolCalls) : [];
    if (calls.length > 0) {
      turnCallCount += calls.length;
      const open = new Map<string, { entry: LogEntry; name: string }>();
      for (const c of calls) {
        const entry = toolCallEntry(c.id, c.name, parseToolArgs(c.arguments), cols);
        entry.copyIds = { itemId: c.id };
        group.push(entry);
        open.set(c.id, { entry, name: c.name });
      }
      i += 1;
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
          const idx = group.indexOf(call.entry);
          const insertAt = idx !== -1 ? idx + 1 : group.length;
          group.splice(
            insertAt,
            0,
            ...stampResultCopy(
              toolResultEntries(
                call.name,
                decoded.value,
                cols,
                tokenCountNote(next.raw.resultTokens, { estimated: true }),
              ),
              id,
            ),
          );
        }
        // Fold the consumed result row into this group: its placeholder
        // must not remain as a separate row. Mark it by advancing i and
        // remembering that the next group index is skipped — handled by
        // the caller via groupTranscriptIndices below.
        i += 1;
      }
      groups.push(group);
      continue;
    }
    if (e.role === "user" || e.role === "assistant") {
      // Copy identity: the transcript row seq is the item id —
      // identical to the full converter.
      group.push({
        kind: e.role,
        lines: [e.text],
        copyText: e.text,
        copyIds: { itemId: String(e.raw.seq) },
      });
    } else if (e.role === "tool") {
      const decoded = decodeToolResult(e.raw);
      const label = e.raw.name ?? e.raw.toolCallId ?? "tool";
      const orphanLine: LogEntry = {
        kind: "tool",
        lines: [
          `${decoded.ok ? "✅" : "❌"} ${label}${decoded.ok ? "" : ` ${decoded.error ?? "failed"}`}`,
        ],
      };
      const orphanId = typeof e.raw.toolCallId === "string" ? e.raw.toolCallId : undefined;
      if (orphanId !== undefined) orphanLine.copyIds = { itemId: orphanId };
      group.push(orphanLine);
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
    } else {
      group.push({ kind: "system", lines: [e.text] });
    }
    groups.push(group);
    i += 1;
  }
  // Final turn summary attaches to the last group (full converter parity).
  flushTurn(null);
  if (pendingSummary.length > 0) {
    const last = groups[groups.length - 1];
    if (last !== undefined) last.push(...pendingSummary);
    else groups.push(pendingSummary);
  }
  return groups;
}

/**
 * Transcript indices covered by each rehydrate group: a tool-call group
 * covers its call row plus every consumed result row, so the swapper
 * knows which placeholders to remove when swapping one group.
 */
export function rehydrateGroupIndices(entries: TranscriptEntry[]): number[][] {
  const idx: number[][] = [];
  let i = 0;
  while (i < entries.length) {
    const e = entries[i]!;
    const calls = e.role === "assistant" ? decodeToolCalls(e.raw.toolCalls) : [];
    const covered = [i];
    i += 1;
    if (calls.length > 0) {
      const open = new Set(calls.map((c) => c.id));
      while (i < entries.length) {
        const next = entries[i]!;
        if (next.role !== "tool") break;
        const id = next.raw.toolCallId;
        if (id === undefined || !open.has(id)) break;
        open.delete(id);
        covered.push(i);
        i += 1;
      }
    }
    idx.push(covered);
  }
  return idx;
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
