/**
 * The app domain's single public door: the composition-root workers
 * (turn driving, session setup, transcript rehydration, terminal wiring,
 * copy sinks) plus the log feed they share.
 */
export {
  type CopySinks,
  copyFailureNotice,
  requestCopy,
  requestTableCopy,
  wireCopySinks,
} from "./copySinks.ts";
export { nextMessageSeq, pushLines, resetEntries } from "./logFeed.ts";
export { pollRunningTurn } from "./pollRunning.ts";
export { startIdleWatch, type IdleWatch, type IdleWatchHost } from "./idleWatch.ts";
export { type ResolvedSession, resolveSession } from "./sessionSetup.ts";
export {
  type CommandEnv,
  executeCommand,
  isCommand,
  resolveCommand,
  roundDelta,
} from "./slashCommands.ts";
export {
  type AppHooks,
  type Terminal,
  keyDumpSink,
  setKeyDumpWriter,
  wireTerminal,
} from "./terminalWiring.ts";
export {
  applyCompaction,
  applyDump,
  clearRehydrate,
  compactionNote,
  driveRehydrate,
  entriesForDump,
  entriesForDumpAfter,
  placeholderSeed,
  stageRehydrate,
  statusTotals,
  syncTranscriptOnSubmit,
  termCols,
  transcriptTokenWeight,
} from "./transcriptRebuild.ts";
export {
  type StateSaver,
  abortActiveTurn,
  applyUsageTotal,
  recordRoundDelta,
  startTurnPresenter,
  turnWithRecovery,
  turnWidth,
  withUsageTracking,
} from "./turnControl.ts";
export { type TurnEnv, submitInput } from "./turnRunner.ts";
export {
  noteTranscriptTail,
  resetTranscriptTailForTests,
  transcriptFloorOf,
  transcriptSignature,
} from "./transcriptSignature.ts";
