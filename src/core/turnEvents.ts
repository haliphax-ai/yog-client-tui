/**
 * Live-turn event handlers — SSE turn events → chat-log mutations.
 *
 * `createTurnEventHandlers` builds the `TurnEvents` callback set for one
 * in-flight turn: streaming prose (with the eager close-of-block and the
 * verbatim copy snapshot), tool-call/result pairing and annotation, the
 * notice lines for aborts/rate-limits/errors/recovery, and the per-turn
 * summary line. Pure event translation: no rendering, no terminal
 * access; `main.ts` wires the callbacks to the client and supplies the
 * column width through the host.
 *
 * The pending tool-call pairing lives here for the duration of a turn;
 * the shared entry builders (`toolEntries.ts`) also serve transcript
 * rehydration, so restored rows render exactly like live ones.
 */
import type { ToolResultEvent, TurnEvents, TokenUsage } from "../client/index.ts";
import { formatDuration, formatRuntime, formatTokenTotal, tokenCountNote } from "./toolFormat.ts";
import { displayWidth, stripAnsi, truncateAnsi } from "../util/index.ts";
import type { LogEntry } from "./entries.ts";
import { noticeLine } from "./notices.ts";
import { annotateToolCall, toolCallEntry, toolResultEntries } from "./toolEntries.ts";
import {
  decodeHarnessNotices,
  harnessNoticeEntries,
  isHarnessNoticeTool,
} from "./harnessNotice.ts";
import type { TurnHost } from "./turnHost.ts";

export type { TurnHost } from "./turnHost.ts";
/** Turn-level total for a usage object (total field, else prompt+completion). */
function usageTotalOf(usage: TokenUsage | undefined): number {
  if (usage === undefined) return 0;
  if (typeof usage.total_tokens === "number") return usage.total_tokens;
  return (
    (typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0) +
    (typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0)
  );
}

/** Human-readable "N prompt · N completion · N total" segments for a terminal
 * notice (max_rounds stop / abort). Empty when the turn has no usage. */
export function usageTokenParts(usage: TokenUsage | undefined): string[] {
  const parts: string[] = [];
  if (usage === undefined) return parts;
  if (typeof usage.prompt_tokens === "number")
    parts.push(`${usage.prompt_tokens.toLocaleString("en-US")} prompt`);
  if (typeof usage.completion_tokens === "number")
    parts.push(`${usage.completion_tokens.toLocaleString("en-US")} completion`);
  if (typeof usage.total_tokens === "number")
    parts.push(`${usage.total_tokens.toLocaleString("en-US")} total`);
  return parts.join(" · ") === "" ? [] : parts;
}

/**
 * The streaming assistant prose segment of one turn: opens a streaming
 * entry on the first delta, appends verbatim (re-split on newlines), and
 * closes the block eagerly when anything interposes (a tool call, an
 * orphan result line, an error/recovery note) — the log tail is the only
 * entry a delta may extend.
 */
export class ProseStream {
  entry?: LogEntry;
  whole = "";
  private readonly host: TurnHost;

  constructor(host: TurnHost) {
    this.host = host;
  }

  /** True when this prose entry is still the log tail (safe to extend). */
  private isTail(): boolean {
    return (
      this.entry !== undefined && this.host.entries[this.host.entries.length - 1] === this.entry
    );
  }

  /** Close the open block: stop streaming, stamp the whole-message copy. */
  close(): void {
    if (this.entry === undefined) return;
    this.entry.streaming = false;
    this.entry.copyIds = {
      itemId: this.entry.copyIds?.itemId ?? "",
      wholeMessage: this.whole,
    };
    this.entry = undefined;
  }

  /** Append one verbatim delta to the tail prose block (opening one if needed). */
  append(text: string): void {
    if (text.trim() === "") return;
    // Invariant: a prose entry is only ever appended to while it is the
    // log tail. Tool calls close the open block eagerly (see onToolCall);
    // if anything else interposed (error/recovery note, orphan result
    // line), close it here too — re-pushing the shared object would make
    // every alias replay every later delta.
    if (this.entry !== undefined && !this.isTail()) {
      this.entry.streaming = false;
      this.entry = undefined;
    }
    const entry = (this.entry ??= { kind: "assistant", lines: [""], streaming: true });
    if (this.host.entries[this.host.entries.length - 1] !== entry) this.host.entries.push(entry);
    // Append to the last (possibly partial) paragraph, re-split on \n.
    const lines = entry.lines;
    const lastIdx = lines.length - 1;
    const merged = `${lines[lastIdx] ?? ""}${text}`;
    lines.splice(lastIdx, 1, ...merged.split("\n"));
    // Copy snapshot: keep the verbatim delta so C copies the raw
    // Markdown even while the entry is still streaming. The whole-
    // message text accumulates across the logical message's chunks.
    entry.copyText = `${entry.copyText ?? ""}${text}`;
    this.whole = `${this.whole}${text}`;
    this.host.requestRender();
  }
}

/** Stamp the tool-call id as the copy item id on the result entries (the
 *  call id is the item id — args and result are one transcript item).
 *  Status lines are not copyable items and stay unstamped. */
function stampCopy(entries: LogEntry[], id: string): LogEntry[] {
  for (const resultEntry of entries) {
    if (resultEntry.kind === "status") continue;
    resultEntry.copyIds = { itemId: id };
  }
  return entries;
}

/** The per-turn summary line for `onFinish`: `runtime X · N tool calls ·
 *  M tokens` (the token delta against the pre-turn session total). */
function finishSummary(
  host: TurnHost,
  durationMs: number,
  usage: TokenUsage | undefined,
  calls: number,
): LogEntry {
  const summary: string[] = [`runtime ${formatRuntime(durationMs)}`];
  summary.push(`${calls} tool call${calls === 1 ? "" : "s"}`);
  if (usage !== undefined) {
    // The server reports the full hydrated-context total, not this turn's
    // contribution — show the delta against the session total before the
    // turn ran (baseline 0 when unknown/first).
    const prev = host.prevTokenTotal?.() ?? 0;
    const delta = Math.max(0, usageTotalOf(usage) - prev);
    if (delta > 0) summary.push(`${formatTokenTotal(delta)} tokens`);
  }
  return { kind: "status", lines: [summary.join(" · ")] };
}

/** The result entries for one tool call (or none — a failed call's ❌
 *  line is the whole failure), stamped with the call's copy identity. */
function resultEntriesFor(host: TurnHost, ev: ToolResultEvent): LogEntry[] {
  if (!(ev.ok && ev.result !== undefined && ev.result !== null)) return [];
  return stampCopy(
    toolResultEntries(
      ev.name,
      ev.result,
      host.width(),
      tokenCountNote(ev.resultTokens, { estimated: true }),
    ),
    ev.id,
  );
}

/** An ORPHAN result — a result whose call row is not pending (its call
 *  line predates this presenter, e.g. after recovery). Standalone ✅/❌
 *  line, plus the result components on success; the call id is the item
 *  id for the copy path. A harness_notice result renders its notices
 *  instead of the ✅/❌ + blob (same branch as the paired path). */
function orphanResult(host: TurnHost, ev: ToolResultEvent): void {
  if (isHarnessNoticeTool(ev.name)) {
    pushHarnessResult(host, ev);
    return;
  }
  host.append("tool", [
    `${ev.ok ? "✅" : "❌"} ${ev.name || "tool"}${ev.ok ? "" : ` ${ev.error ?? "failed"}`}`,
  ]);
  host.entries.push(...resultEntriesFor(host, ev));
}

/** A PAIRED result: splice the result components right after the call
 *  line they answer. THIS call's token count is the per-result tokenx
 *  estimate (~N tok) from the server — no fallbacks: pre-release, the
 *  server always sends resultTokens. Round-level real numbers
 *  (promptDelta) fold into session totals once via onRoundDelta. */
function insertPairedResult(host: TurnHost, call: LogEntry, ev: ToolResultEvent): void {
  const results = resultEntriesFor(host, ev);
  if (results.length === 0) return;
  const at = host.entries.indexOf(call);
  host.entries.splice(at === -1 ? host.entries.length : at + 1, 0, ...results);
}

/** Push a harness_notice result's entries (the paired and orphan paths
 *  share this branch — notice lines plus any attached tool result, no
 *  result blob). The result entries carry the call id as their copy item
 *  id, like every other paired result. */
function pushHarnessResult(host: TurnHost, ev: ToolResultEvent): void {
  // The result entries are the transcript item: stamp the call id as the
  // copy item id, the same rule every other paired result follows.
  host.entries.push(
    ...stampCopy(harnessNoticeEntries(decodeHarnessNotices(ev.result) ?? []), ev.id),
  );
}

/**
 * Build the live-turn `TurnEvents` handler set. One instance per turn
 * (one `submit()`); the returned callbacks mutate the host's log and
 * request renders through it.
 */
/** Append a `turn aborted` notice unless the log tail is identical
 *  (one Esc aborting a FIFO chain emits one turn.aborted per handle). */
function appendAbortNotice(host: TurnHost, detail: string): void {
  const fresh = noticeLine("notice", "turn aborted", detail);
  const last = host.entries.at(-1);
  const same =
    last?.kind === "notice" &&
    last.lines.length === fresh.length &&
    last.lines.every((line, i) => stripAnsi(line) === stripAnsi(fresh[i] ?? ""));
  if (!same) host.append("notice", fresh);
}

export function createTurnEventHandlers(host: TurnHost, prose: ProseStream): TurnEvents {
  // Tool call id → its log entry, so results can annotate the call line.
  const pendingToolCalls = new Map<string, LogEntry>();
  // Tool calls announced during this turn (reset per presenter = per turn).
  let toolCallsThisTurn = 0;

  return {
    onDelta: (text) => prose.append(text),

    onToolCall: (id, name, args) => {
      // A tool call ends the open prose segment: close it on the spot so
      // any later prose streams into a fresh block of its own (the onDelta
      // tail guard below is the generic backstop).
      prose.close();
      if (isHarnessNoticeTool(name)) {
        // The harness-notice synthetic renders nothing on the call side —
        // all information lives in the result — but it still registers so
        // its result pairs (as notices, not a blob). The pending map only
        // needs AN entry to pair against; a bare marker never renders.
        pendingToolCalls.set(id, { kind: "tool", lines: [], harnessTool: name });
        host.requestRender();
        return;
      }
      toolCallsThisTurn += 1;
      const entry = toolCallEntry(id, name, args, host.width());
      entry.copyIds = { itemId: id };
      host.entries.push(entry);
      pendingToolCalls.set(id, entry);
      host.requestRender();
    },

    onToolResult: (ev) => {
      // Annotate the matching call line in place (no extra chat lines).
      const call = pendingToolCalls.get(ev.id);
      if (call === undefined) {
        orphanResult(host, ev);
        host.requestRender();
        return;
      }
      pendingToolCalls.delete(ev.id);
      // A harness_notice pair renders its notices (plus any attached tool
      // result) instead of a result blob; there is no call row to annotate
      // — all information lives in the result.
      if (call.harnessTool !== undefined) {
        pushHarnessResult(host, ev);
        host.requestRender();
        return;
      }
      annotateToolCall(call, ev.ok, ev.error);
      // The last result of a round drains the pending map — the one place
      // the round's REAL promptDelta folds into live session totals, so a
      // batch never counts its round more than once.
      if (pendingToolCalls.size === 0 && ev.promptDelta !== undefined) {
        host.onRoundDelta?.(ev.promptDelta);
      }
      insertPairedResult(host, call, ev);
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
      // One Esc can abort a FIFO chain (a wake head + the queued turn):
      // each emits its own turn.aborted. Collapse consecutive identical
      // abort notices — the second says nothing the first didn't.
      appendAbortNotice(host, detail);
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
      host.append("status", [
        finishSummary(host, durationMs, usage, toolCallsThisTurn).lines[0] ?? "",
      ]);
    },
  };
}

/** The presenter lifecycle over the event handlers: begin (stamp the user
 *  prompt), finish (close the prose block), fail (record the error line). */
export function createTurnLifecycle(
  host: TurnHost,
  prose: ProseStream,
): {
  begin(input: string): void;
  finish(): void;
  fail(detail: string): void;
} {
  return {
    begin: (input) => {
      // Copy identity (#109): the prompt is the transcript item — the
      // server assigns the next message seq, and the item id rides the
      // entry; the raw prompt text doubles as the copy snapshot.
      const entry: LogEntry = { kind: "user", lines: [input], copyText: input };
      entry.copyIds = { itemId: host.nextMessageSeq() };
      host.entries.push(entry);
      prose.entry = undefined;
    },
    finish: () => {
      prose.close();
    },
    fail: (detail) => {
      host.append("error", noticeLine("error", "turn failed", detail));
    },
  };
}

// -- width-domain re-exports for the presenter surface ---------------------
export { displayWidth, truncateAnsi };
