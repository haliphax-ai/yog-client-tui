/**
 * The util domain's single public door: terminal-cell math and fuzzy
 * matching. A leaf — it imports nothing from any other domain.
 */
export {
  displayWidth,
  matchEscape,
  scrollLeft,
  stripAnsi,
  truncateAnsi,
  wrapText,
} from "./ansi.ts";
export { type FuzzyMatch, type FuzzyOptions, fuzzyFind, fuzzyMatches } from "./fuzzy.ts";
