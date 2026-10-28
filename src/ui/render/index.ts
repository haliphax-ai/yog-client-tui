/** Entry rendering: per-entry rows, the memoized row cache, and row accounting. */
export { cachedRows, highlightBlock, renderMarkdown, totalRows } from "./entry.ts";
export { colorizeToolLine } from "./colorize.ts";
export { prettyArgs, resultPreview, resultStatus } from "./formatting.ts";
export type { EntryKind, LogEntry } from "./types.ts";