/**
 * Copy semantics for chat-log entries: what `C` / `Shift+C` / `O`
 * mean for each entry kind — the raw Markdown, the whole assistant
 * message, the copied tool JSON, and the `O` output filename.
 *
 * This lives in `core` because it is domain data shaping, not
 * presentation: the request site (the viewport) and the sinks (clipboard
 * writer and `out/` writer, wired by the composition root) both consume
 * it, and neither may invent its own per-tool rules. Terminal- and
 * fs-free.
 *
 * Tools are given a universal way to provide their copyable payloads: a
 * registry of per-tool providers below. A tool without a provider falls
 * back to the universal whole-call JSON blob.
 */
import { getState } from "./store.ts";
import { parseToolArgs } from "../yogClient.ts";
import type { LogEntry } from "./entries.ts";
import type { ParsedTable } from "./tableShape.ts";

/** The focused-entry identity: item id for the toast and the `O`
 *  filename, session id for the `<session id>_<item id>` prefix. Set by
 *  the shared entry builders (live turns and transcript rehydration). */
export interface CopyIds {
  /** This transcript item's id (`message.seq` / `tool.call` id). */
  itemId: string;
  /** The owning session id (builders stamp it from the client). */
  sessionId?: string;
  /** Whole-message copy text, stamped on the LAST assistant prose
   *  chunk of a logical message (Shift+C's whole-message copy). */
  wholeMessage?: string;
}

/** The copy provider signature: the payload → the copyable text, or
 *  null when the provider declines this shape (universal fallback). */
export type CopyProvider = (payload: unknown) => string | null;

/** The copy providers of one tool: args block vs results block. */
export interface ToolCopyProviders {
  args: CopyProvider;
  results: CopyProvider;
}

/**
 * The registry of tool-specific copy providers, keyed by tool name.
 * Registration is the universal extension point: a tool opts into
 * copy semantics here instead of the UI growing per-tool branches.
 */
const COPY_PROVIDERS: Record<string, ToolCopyProviders> = {
  bash: { args: bashArgsProvider, results: bashResultsProvider },
};

/** The copy registry entry for a tool name, or undefined. */
export function copyProvidersFor(tool: string): ToolCopyProviders | undefined {
  return COPY_PROVIDERS[tool];
}

/**
 * The bash tool's ARGS provider: the `command` arg value only —
 * not the whole JSON object. Any other shape declines (null).
 */
function bashArgsProvider(payload: unknown): string | null {
  const obj = payloadObject(payload);
  if (obj === undefined) return null;
  const command = obj["command"];
  return typeof command === "string" ? command : null;
}

/**
 * The bash tool's RESULTS provider: a Markdown blob —
 * a YAML front-matter runtime line, then `## stdout` / `## stderr`
 * sections. Declines when there is no runtime/exit fact to show.
 */
function bashResultsProvider(payload: unknown): string | null {
  const obj = payloadObject(payload);
  if (obj === undefined) return null;
  const runtime = numberField(obj, "runtimeMs") ?? numberField(obj, "runtime");
  const exit = numberField(obj, "exitCode");
  if (runtime === undefined && exit === undefined) return null;
  const facts: string[] = [];
  if (runtime !== undefined) facts.push(`runtime: ${runtime}ms`);
  if (exit !== undefined) facts.push(`exit code: ${exit}`);
  const sections: string[] = [];
  for (const field of ["stdout", "stderr"] as const) {
    const value = obj[field];
    if (typeof value !== "string" || value === "") continue;
    sections.push(`## ${field}`, "", value.replace(/\n$/, ""), "");
  }
  if (sections.length === 0) return null;
  return `---\n${facts.join("\n")}\n---\n\n${sections.join("\n").trimEnd()}\n`;
}

/**
 * The universal fallback: the ENTIRE tool-call JSON the model sent —
 * `{ "name": <tool>, "arguments": <args> }` pretty-printed, exactly the
 * pre-routing `tool.call` envelope. Every tool can always be copied
 * something meaningful. This is also what `Shift+C` copies on a tool
 * entry: the whole call (providers are skipped, mirroring prose's
 * whole-message copy).
 */
export function universalJsonCopy(entry: LogEntry): string {
  return JSON.stringify(
    {
      name: entryToolName(entry),
      arguments: typeof entry.argsRaw === "string" ? parseToolArgs(entry.argsRaw) : null,
    },
    undefined,
    2,
  );
}

/** The payload a provider sees: the call's raw args for a call entry,
 *  the result otherwise (chunks and generic results carry it). */
function copySourceOf(entry: LogEntry): unknown {
  if (entry.kind === "tool") return entry.argsRaw;
  return entry.result ?? entry.argsRaw;
}

/**
 * The clipboard text for `C` on a prose entry: the entry's raw Markdown.
 * `copyText` is stamped by the shared builders at entry-build time (the
 * verbatim delta before any in-place label edits); entries without the
 * snapshot fall back to their own logical lines.
 */
export function entryCopyText(entry: LogEntry): string {
  if (typeof entry.copyText === "string" && entry.copyText !== "") return entry.copyText;
  return entry.lines.join("\n");
}

/**
 * The clipboard text for `Shift+C` on a prose entry: the whole message —
 * every prose chunk and table of the logical message. The last prose
 * chunk of the message carries the stamped `wholeMessage` text; a user
 * entry copies its own raw Markdown (one item, same thing); anything
 * else declines (null — nothing to whole-copy).
 */
export function wholeMessageCopyText(entry: LogEntry): string | null {
  if (entry.kind === "user") return entryCopyText(entry);
  if (entry.kind !== "assistant") return null;
  // The whole-message stamp rides the LAST prose chunk of a logical
  // message (live) / run (rehydrate). A chunk BEFORE the tail carries no
  // stamp — resolve it by scanning the run in the store.
  if (typeof entry.copyIds?.wholeMessage === "string" && entry.copyIds.wholeMessage !== "") {
    return entry.copyIds.wholeMessage;
  }
  return proseWholeFromStore(entry);
}

/**
 * Scan the store for the stamped prose chunk of the message `entry`
 * belongs to: walk back to the run's first assistant chunk (consecutive
 * assistant rows between tool calls), then forward to the run's stamped
 * tail. Pure read — no rebuild, no stamping here.
 */
function proseWholeFromStore(entry: LogEntry): string | null {
  const entries = getState().entries;
  const at = entries.indexOf(entry);
  if (at < 0) return null;
  let start = at;
  while (start > 0) {
    const prev = entries[start - 1] as LogEntry | undefined;
    if (prev === undefined || prev.kind !== "assistant") break;
    start -= 1;
  }
  for (let i = start; i < entries.length; i++) {
    const e = entries[i] as LogEntry | undefined;
    if (e === undefined || e.kind !== "assistant") break;
    const whole = e.copyIds?.wholeMessage;
    if (typeof whole === "string" && whole !== "") return whole;
  }
  return null;
}

/**
 * One table's raw Markdown, re-serialized GFM: the header row, the
 * delimiter row (alignment restored), and every data row, cells joined
 * with ` | ` and the usual outer pipes. Cell pipes are escaped so the
 * output re-parses to the same table; multi-line cells (<br> display
 * breaks) flatten to spaces — a pipe row must stay one line.
 */
export function tableMarkdown(table: ParsedTable): string {
  const escape = (cell: string): string => cell.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
  const row = (cells: string[]): string => `| ${cells.map(escape).join(" | ")} |`;
  const align = (a: "left" | "center" | "right"): string =>
    a === "center" ? ":---:" : a === "right" ? "---:" : "---";
  const head = table.columns.map((c) => c.title);
  const delim = table.columns.map((c) => align(c.align));
  return [row(head), row(delim), ...table.rows.map(row)].join("\n");
}
/** The copy request for one table of a prose entry: the TABLE is the
 *  copy unit — its re-serialized raw Markdown, identified as the
 *  containing entry's item id PLUS the table's child position within
 *  the message (`<session>_<entry id>_<child index>`; tables are the
 *  entry's children, so the list position is the child id — the
 *  suffix counts TABLES only, matching the focus ring). Plain and Shift
 *  are identical at the table level (nothing larger inside it); null
 *  when the entry carries no identity. */
export function tableCopyRequest(
  entry: LogEntry,
  table: ParsedTable,
  tableIndex: number,
  sessionId: string | undefined,
): CopyRequest | null {
  const id = copyItemId(entry);
  if (id === undefined) return null;
  return {
    content: tableMarkdown(table),
    itemId: `${sessionId === undefined ? "" : `${sessionId}_`}${id}_${tableIndex}`,
    provided: true,
  };
}
/** Everything a copy sink needs: the content plus its identity. */
export interface CopyRequest {
  /** The text for the clipboard / the `out/` file. */
  content: string;
  /** `<session id>_<item id>` (bare item id when no session is known). */
  itemId: string;
  /** True when a per-tool provider produced the content (diagnostic). */
  provided: boolean;
}

/** The item id of a focused entry, or undefined when it has none. */
export function copyItemId(entry: LogEntry): string | undefined {
  return entry.copyIds?.itemId;
}

/** The sink surface the viewport calls: the composition root wires
 *  the clipboard/file writers; the viewport only builds requests and
 *  hands them back. */
export interface CopyActions {
  /** Build the copy request for the focused entry (null = uncopyable). */
  request(entry: LogEntry, upper: boolean): CopyRequest | null;
  /** Build the copy request for the focused table (`table` = its index
   *  within `entry`). The table is the copy unit at the inner ring —
   *  its own Markdown under the parent's id + the child suffix; plain
   *  only (Shift routes to the parent at the viewport). Null = the
   *  table vanished or the entry has no copy identity. */
  requestTable(entry: LogEntry, table: number): CopyRequest | null;
  /** Run the clipboard sink. */
  copy(request: CopyRequest): void;
  /** Run the `out/` file sink. */
  output(request: CopyRequest): void;
}

/** The copy request for `C` / `Shift+C` on a tool entry, or null when
 *  the entry carries no copy identity (never copied, no toast). The
 *  copy semantics mirror `toolCopyContent`: providers on plain `C`, the
 *  whole-JSON item blob on `Shift+C`. */
export function toolCopyRequest(
  entry: LogEntry,
  sessionId: string | undefined,
  upper: boolean,
): CopyRequest | null {
  const id = copyItemId(entry);
  if (id === undefined) return null;
  const providers = upper ? undefined : copyProvidersFor(entryToolName(entry));
  const provider =
    providers === undefined
      ? undefined
      : entry.kind === "tool"
        ? providers.args
        : providers.results;
  const provided = provider === undefined ? null : provider(copySourceOf(entry));
  return {
    content: provided ?? universalJsonCopy(entry),
    itemId: sessionId === undefined ? id : `${sessionId}_${id}`,
    provided: provided !== null,
  };
}

/** The copy request for `C` / `Shift+C` on a prose entry, or null. */
export function proseCopyRequest(
  entry: LogEntry,
  sessionId: string | undefined,
  upper: boolean,
): CopyRequest | null {
  const id = copyItemId(entry);
  if (id === undefined) return null;
  const content = upper ? wholeMessageCopyText(entry) : entryCopyText(entry);
  if (content === null || content === "") return null;
  return {
    content,
    itemId: sessionId === undefined ? id : `${sessionId}_${id}`,
    provided: true,
  };
}

/** The tool name of a tool entry (registry key). Call lines and generic
 *  results carry the label `⚙️ <tool>` / `🔚 <tool>` (annotations append
 *  to the END), so the tool name is the second token; result chunks have
 *  no label — their header's first token IS the tool name
 *  (`bash → exit 0 · 42ms`), the same name the builders wrote. */
function entryToolName(entry: LogEntry): string {
  const head = entry.label ?? entry.lines[0] ?? "";
  const parts = head.split(" ");
  if (parts[0] === "⚙️" || parts[0] === "🔚") return (parts[1] as string) ?? "tool";
  if (entry.kind === "chunk" && parts[0] !== "") return parts[0] as string;
  return "tool";
}

// -- payload normalization -------------------------------------------------

/** The payload as an object (JSON strings are parsed first; arrays and
 *  primitives decline with undefined). */
function payloadObject(payload: unknown): Record<string, unknown> | undefined {
  let value = payload;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** A finite numeric field of a payload object. */
function numberField(obj: Record<string, unknown>, field: string): number | undefined {
  const value = obj[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
