/**
 * The ui domain's root modules — theme, focus-ring view, clipboard,
 * debug log — as the door for everything at the top of `ui/`. The
 * sub-domains (components, pipeline, render) keep their own barrels.
 */
export { type CopyOutcome, runWlCopy } from "./clipboard.ts";
export {
  DEBUG_HEADER,
  emitDebug,
  isDebugEnabled,
  isKeyLogEnabled,
  keyLogPath,
  setKeyDumpSink,
} from "./debugLog.ts";
export { focusUnits } from "./focus.ts";
export {
  C,
  CHUNK_HEADER,
  CONTEXT_WINDOW,
  CURSOR_COLOR,
  CURSOR_COLOR_BLUR,
  GLAMOUR_THEME,
  INPUT_PURPLE,
  ST,
} from "./theme.ts";
