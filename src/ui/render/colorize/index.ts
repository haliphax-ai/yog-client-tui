/**
 * The colorize engine's single public door: the row scanner, the
 * output assembly, the cross-row string carry, the status indicators,
 * and the character-domain literal matchers.
 */
export { type Emitter, freshRow, put, releaseHead } from "./emit.ts";
export { type Indicator, indicatorAt, indicatorColor, isIndicatorStart } from "./indicators.ts";
export { type RowCarry, emptyCarry } from "./rowCarry.ts";
export { type RowScan, scanRowText } from "./scanner.ts";
export { matchLiteral, matchNumber } from "./slice.ts";
