/**
 * Copy/output sinks for the composition root: the clipboard writer and
 * the `out/` file writer, plus the copy request dispatch the viewport
 * asks for. The sinks live here because fs/process access is
 * composition-root-only (`ui/` builds requests; this module runs them).
 */
import { splitTableSections } from "../ui/render/table/index.ts";
import { runWlCopy } from "../ui/index.ts";
import { pushLines } from "./logFeed.ts";
import { noticeLine } from "../core/index.ts";
import {
  proseCopyRequest,
  tableCopyRequest,
  toolCopyRequest,
  type CopyRequest,
} from "../core/index.ts";
import type { LogEntry } from "../core/index.ts";

/** The wired sinks the viewport calls back into. */
export interface CopySinks {
  request(entry: LogEntry, upper: boolean): CopyRequest | null;
  requestTable(entry: LogEntry, table: number): CopyRequest | null;
  copy(request: CopyRequest): void;
  output(request: CopyRequest): void;
}

/** What the copy sinks need of a toast: `show`. Structural so app/ does
 *  not reach into ui/ components for the type. */
type Toaster = { show(message: string): void };

/** Clipboard sink: write the content with wl-copy; surface failures as an
 *  error notice, successes as the 📋 toast. */
function copyToClipboard(toast: Toaster, request: CopyRequest): void {
  const outcome = runWlCopy(request.content);
  if (outcome.ok) {
    toast.show(`📋 entry \`${request.itemId}\` copied to the system clipboard`);
    return;
  }
  pushLines("error", noticeLine("error", "copy failed", outcome.error));
}

/** The copy request for `C` / `Shift+C` on one entry (or null). */
export function requestCopy(
  entry: LogEntry,
  sessionId: string | undefined,
  upper: boolean,
): CopyRequest | null {
  if (entry.kind === "tool" || entry.kind === "toolResult" || entry.kind === "chunk") {
    return toolCopyRequest(entry, sessionId, upper);
  }
  if (entry.kind === "user" || entry.kind === "assistant") {
    return proseCopyRequest(entry, sessionId, upper);
  }
  return null;
}

/** Table copy: the TABLE is the copy unit at the inner ring — its raw
 *  Markdown re-serialized from the parsed columns/rows, identified by
 *  the parent's item id plus the table's child position (the table
 *  index is the child id — it matches what the focus ring walks). Shift
 *  never reaches this path (the viewport routes it to the parent
 *  entry). */
export function requestTableCopy(
  entry: LogEntry,
  table: number,
  sessionId: string | undefined,
): CopyRequest | null {
  if (entry.kind !== "user" && entry.kind !== "assistant") return null;
  const sections = splitTableSections(entry.lines.join("\n")).filter((s) => s.kind === "table");
  const section = sections[table];
  if (section === undefined || section.kind !== "table") return null;
  return tableCopyRequest(entry, section.table, table, sessionId);
}

/** The copy-only sinks (the `out/` file sink is wired by the composition
 *  root, which owns the filesystem). */
export function wireCopySinks(
  toast: Toaster,
  sessionId: () => string | undefined,
  outputToFile: (request: CopyRequest) => void,
): CopySinks {
  return {
    request: (entry, upper) => requestCopy(entry, sessionId(), upper),
    requestTable: (entry, table) => requestTableCopy(entry, table, sessionId()),
    copy: (request) => copyToClipboard(toast, request),
    output: outputToFile,
  };
}

/** The copy-failure notice shared by both sinks. */
export function copyFailureNotice(what: string, err: unknown): void {
  pushLines("error", noticeLine("error", what, err instanceof Error ? err.message : String(err)));
}
