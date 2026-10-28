/** Entry rendering: per-entry rows, memoization, and the rendered frame. */
export { cachedRows, highlightBlock, renderMarkdown } from "./entry.ts";
export { colorizeToolLine } from "./colorize.ts";
export { prettyArgs, resultPreview, resultStatus } from "./formatting.ts";
export { render, totalRows } from "./compose.ts";
export type { EntryKind, LogEntry, RenderState } from "./types.ts";