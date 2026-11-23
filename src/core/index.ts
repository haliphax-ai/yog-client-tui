/**
 * The core domain's single public door: the entry model, the state
 * store, the focus ring, scroll math, notices, slash commands, the copy
 * vocabulary, and the turn presenter.
 *
 * The turn-presenter surface (entry builders, rehydrate groups, the
 * host/port seams and their shared metric types) flows through
 * `turnPresenter.ts` — the facade those leaf modules already re-export —
 * so each shared symbol has exactly one export site here.
 */
export {
  type CommandDescriptor,
  LOCAL_COMMANDS,
  type SlashCommand,
  SLASH_COMMANDS,
  completeSlash,
  isSlash,
  registryVersion,
  requiresArgs,
  resolveSlash,
  setServerCommands,
  slashToken,
  slashTokenEnd,
} from "./commands.ts";
export {
  type CopyActions,
  type CopyIds,
  type CopyProvider,
  type CopyRequest,
  type ToolCopyProviders,
  copyItemId,
  copyProvidersFor,
  entryCopyText,
  proseCopyRequest,
  tableCopyRequest,
  tableMarkdown,
  toolCopyRequest,
  universalJsonCopy,
  wholeMessageCopyText,
} from "./copyText.ts";
export {
  type EntryKind,
  type LogEntry,
  type TableState,
  tableState,
  tableStateOf,
} from "./entries.ts";
export { FOCUS_NONE, FOCUS_NONE_TARGET, type FocusTarget, moveFocus } from "./focus.ts";
export { type NoticeKind, noticeLine } from "./notices.ts";
export { type ScrollState, clampScroll, jump, scrollBy } from "./scroll.ts";
export { addLiveCompletionTokens, getState, resetForTests, setState, subscribe, type UiState } from "./store.ts";
export { type ParsedColumn, type ParsedTable } from "./tableShape.ts";
export {
  compactArgs,
  formatDuration,
  formatRuntime,
  formatTokenTotal,
  isBashShaped,
  prettyArgs,
  resultStatus,
  tokenCountNote,
} from "./toolFormat.ts";
export { stepFor, type Step } from "./rehydrateSteps.ts";
export { TurnTracker, turnIdOf, usageTotal } from "./turnTracker.ts";
export {
  type ProseStream,
  createTurnEventHandlers,
  createTurnLifecycle,
  usageTokenParts,
} from "./turnEvents.ts";
export {
  type TranscriptEntry,
  type TranscriptRole,
  decodeToolCalls,
  decodeToolResult,
  decodeTurnUsage,
  estimatedContextTotal,
  finalContextTotal,
  perTurnDeltas,
  toTranscriptEntries,
  transcriptText,
} from "./transcript.ts";
export {
  type AppendEntry,
  type TurnHost,
  type TurnPresenter,
  annotateToolCall,
  createTurnPresenter,
  placeholderForTranscriptEntry,
  placeholderLogEntries,
  rehydrateGroupIndices,
  rehydrateGroups,
  toolCallEntry,
  toolResultChunk,
  toolResultEntry,
  toolResultEntries,
  transcriptLogEntries,
  type TranscriptRehydrateOpts,
  type TranscriptTurnMetrics,
} from "./turnPresenter.ts";
