/**
 * Shared tool-call entry builders: the ⚙️ call line, its ✅/❌ annotation,
 * and the result components (the collapsible bash-style output chunk and
 * the generic 🔚 result block). One definition for BOTH producers of tool
 * rows — the live turn path and transcript rehydration — so a rehydrated
 * row renders exactly like a live one (same label, same copy stamps).
 *
 * Pure builders: no store access, no rendering. The caller stamps copy
 * identity (`copyIds`), which owns the ids.
 */
import {
  compactArgs,
  formatRuntime,
  prettyArgs,
  resultStatus,
  isBashShaped,
} from "./toolFormat.ts";
import type { LogEntry } from "./entries.ts";

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
