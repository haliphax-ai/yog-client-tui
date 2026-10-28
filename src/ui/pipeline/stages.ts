/**
 * The render stage vocabulary: a fixed, ordered list of stages every frame
 * passes through. The order is data, not convention — the stage runner walks
 * this array, so stage order is deterministic by construction.
 *
 *   layout   → measure rows, resolve viewport / scroll / width
 *   paint    → each component renders its rows
 *   compose  → join viewport + input + status
 *   post     → pad / truncate ANSI lines to width
 *   emit     → write the frame out (single owner)
 */

export type Stage = "layout" | "paint" | "compose" | "post" | "emit";

/** Stage names in the exact order they run for every frame. */
export const STAGES: readonly Stage[] = Object.freeze([
  "layout",
  "paint",
  "compose",
  "post",
  "emit",
] as const);

/** Type guard: is `value` a known stage name? */
export function isStage(value: unknown): value is Stage {
  return typeof value === "string" && (STAGES as readonly string[]).includes(value);
}