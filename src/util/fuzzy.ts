/**
 * Reusable fuzzy string matching — subsequence search with scoring, for
 * autocomplete / filtering across the app. Pure and terminal-free: given a
 * needle and a haystack of candidate strings it returns ranked matches, so
 * any caller can plug it in without caring about how the matching works.
 *
 * Matching is substring-agnostic: the needle's characters must appear in
 * order within a candidate (a subsequence), but need not be contiguous.
 * Scoring rewards the good matches — a hit at the start of the string or
 * of a word/camel hump, consecutive runs, and exact case — and penalizes
 * gaps and case mismatches. Higher score wins; ties keep haystack order.
 */

/** Options shared by {@link fuzzyMatches} and {@link fuzzyFind}. */
export interface FuzzyOptions {
  /** Match case-sensitively (default: false — case-insensitive). */
  readonly caseSensitive?: boolean;
  /** Cap the number of results (default: every match). */
  readonly limit?: number;
}

/** One fuzzy match: the candidate, its score, and the indices its needle
 *  matched at (useful for later highlighting). */
export interface FuzzyMatch {
  readonly item: string;
  readonly score: number;
  readonly indices: readonly number[];
}

const SCORE_MATCH = 1;
const SCORE_START = 12; // the very first character of the candidate
const SCORE_BOUNDARY = 24; // start of a word / camel hump
const SCORE_CONSECUTIVE = 8; // continued a consecutive run
const PENALTY_GAP = 1; // per skipped character between matches
const PENALTY_CASE = 3; // same character, different case

/** True when `at` in `s` is the start of a word or camel hump. */
function isBoundary(s: string, at: number): boolean {
  if (at === 0) return true;
  const prev = s[at - 1] as string;
  const cur = s[at] as string;
  if (prev === " " || prev === "-" || prev === "_" || prev === "/") return true;
  if (prev === "." || prev === ":" || prev === "\\") return true;
  // camelCase: lowercase → uppercase transition.
  return prev >= "a" && prev <= "z" && cur >= "A" && cur <= "Z";
}

/**
 * Indices of every needle character found in the candidate, in needle
 * order; null when some character is missing (the needle is not a
 * subsequence of the candidate).
 */
function hitIndices(needle: string, candidate: string): number[] | null {
  const indices: number[] = [];
  let from = 0;
  for (let i = 0; i < needle.length; i++) {
    const at = candidate.indexOf(needle[i] as string, from);
    if (at === -1) return null;
    indices.push(at);
    from = at + 1;
  }
  return indices;
}

/**
 * Score one hit: the match itself plus its positional bonus (start of the
 * candidate or of a word/camel hump), then the run/gap adjustment against
 * the previous hit, then the case penalty for a case-folded match.
 */
function scoreOf(
  at: number,
  prev: number | undefined,
  needleChar: string,
  candidate: string,
  caseSensitive: boolean,
): number {
  let s = SCORE_MATCH;
  if (at === 0) s += SCORE_START;
  else if (isBoundary(candidate, at)) s += SCORE_BOUNDARY;
  if (prev !== undefined) {
    if (at === prev + 1) s += SCORE_CONSECUTIVE;
    else s -= (at - prev - 1) * PENALTY_GAP;
  }
  if (!caseSensitive && (candidate[at] as string) !== needleChar) s -= PENALTY_CASE;
  return s;
}

/**
 * Score one candidate against a needle. Returns null when the needle is not
 * a subsequence of the candidate (no match). An empty needle matches
 * anything with score 0 (used to list every candidate).
 */
export function fuzzyMatches(
  needle: string,
  candidate: string,
  options: FuzzyOptions = {},
): FuzzyMatch | null {
  const { caseSensitive = false } = options;
  if (needle === "") return { item: candidate, score: 0, indices: [] };
  if (needle.length > candidate.length) return null;
  const q = caseSensitive ? needle : needle.toLowerCase();
  const c = caseSensitive ? candidate : candidate.toLowerCase();
  const indices = hitIndices(q, c);
  if (indices === null) return null;
  let score = 0;
  for (const [i, at] of indices.entries()) {
    score += scoreOf(at, indices[i - 1], needle[i] as string, candidate, caseSensitive);
  }
  return { item: candidate, score, indices };
}

/**
 * Find and rank all candidates in the haystack that match the needle.
 * Results are sorted by score descending; ties keep the haystack order
 * (a stable sort). The optional `limit` caps how many are returned.
 */
export function fuzzyFind(
  needle: string,
  haystack: readonly string[],
  options: FuzzyOptions = {},
): FuzzyMatch[] {
  const matches = haystack
    .map((item) => fuzzyMatches(needle, item, options))
    .filter((match): match is FuzzyMatch => match !== null);
  matches.sort((a, b) => b.score - a.score);
  const limit = options.limit ?? matches.length;
  return matches.slice(0, Math.max(0, limit));
}
