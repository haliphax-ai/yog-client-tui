/**
 * The component layer's single public door: the bubbletea-backed
 * components, the key router, input decoding, the slash menu, and the
 * drawer registry.
 */
export { ChatLogComponent } from "./ChatLogComponent.ts";
export { ChatViewport } from "./ChatViewport.ts";
export {
  type Component,
  BaseComponent,
  type KeyResult,
  measureRows,
  type RenderContext,
  type RenderResult,
} from "./Component.ts";
export { DrawerComponent } from "./DrawerComponent.ts";
export { GeneratingComponent } from "./GeneratingComponent.ts";
export {
  BACKGROUND_JOBS_FEATURE,
  JOBS_MAX_ROWS,
  JOBS_POLL_MS,
  type JobAnnouncer,
  type JobRowInput,
  JOBS_HEADERS,
  jobsTable,
  JobsDrawerComponent,
  jobRowCells,
  visibleJobs,
} from "./JobsDrawerComponent.ts";
export { InputComponent, MAX_CONTENT_ROWS, MAX_INPUT_CHARS, MAX_LINES } from "./InputComponent.ts";
export {
  formatTokenTotal,
  sessionStats,
  statsSegment,
  StatusComponent,
  statusBody,
} from "./StatusComponent.ts";
export { ToastComponent } from "./ToastComponent.ts";
export { ViewportComponent } from "./ViewportComponent.ts";
export {
  type DrawerCommand,
  type DrawerCommandProvider,
  type DrawerDismissable,
  dismissDrawerChildren,
  drawerCommands,
  drawerSlashCommands,
  registerDrawerChild,
  registeredDrawerChildren,
  resetDrawerRegistryForTests,
  runDrawerCommand,
} from "./drawerRegistry.ts";
export {
  type InputHandlers,
  PASTE_END,
  PASTE_START,
  createInputDecoder,
  matchSequence,
} from "./inputDecode.ts";
export {
  type Globals,
  type TopLevelTarget,
  cycleFocus,
  getTopLevel,
  routeChar,
  routeKey,
  setTopLevel,
} from "./keyRouter.ts";
export {
  type EntryBounds,
  type FocusWindow,
  entryAt,
  entryBounds,
  toggleEntry,
  visibleFocusUnit,
} from "./logFocus.ts";
export { LEGACY_SEQ_KEYS, type SeqKey, parseSeqKey } from "./seqKeys.ts";
export { MAX_MENU_ROWS, slashMenu } from "./slashMenu.ts";
