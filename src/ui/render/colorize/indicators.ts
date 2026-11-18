/**
 * Status-indicator tokens for the tool-line colorizer: the ✓/✗ family
 * (the presentation emoji ✅/❌ are the same glyphs plus their VS-16
 * variant selector, which folds in here — and renders TWO cells wide).
 */
import { C } from "../../theme.ts";

/** An indicator token: the glyph (selector included) and its color. */
export type Indicator = { glyph: string; color: string };

/** The base indicator glyphs (before their optional VS-16 selector). */
const GLYPHS = ["✅", "❌", "✓", "✗"] as const;

/** Whether `ch` starts an indicator token. */
export const isIndicatorStart = (ch: string): boolean => (GLYPHS as readonly string[]).includes(ch);

/** The color of an indicator token: green for ✓, red for ✗. */
export const indicatorColor = (ch: string): string => (ch === "✅" || ch === "✓" ? C.ok : C.fail);

/** The indicator token at `i`, folding in its VS-16 selector when present.
 *  `ch` must satisfy {@link isIndicatorStart}. */
export function indicatorAt(row: string, i: number, ch: string): Indicator {
  const vs16 = row[i + 1] === "\uFE0F" ? "\uFE0F" : "";
  return { glyph: ch + vs16, color: indicatorColor(ch) };
}
