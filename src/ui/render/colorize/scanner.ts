/**
 * Per-row tokenizer for the tool-line colorizer.
 *
 * A single pass over the row's characters, copy-verbatim-with-color: the
 * row's content is emitted unchanged, wrapped in the theme's token colors.
 * The dispatch order below IS the row's token grammar; each step is a
 * named function with one concern, and the flat while loop replaces what
 * used to be a five-deep flag-state nest.
 */
import { matchEscape } from "../../../util/ansi.ts";
import { C } from "../../theme.ts";
import type { Emitter } from "./emit.ts";
import { put, releaseHead } from "./emit.ts";
import { isIndicatorStart, indicatorAt } from "./indicators.ts";
import type { RowCarry } from "./rowCarry.ts";
import { matchLiteral, matchNumber } from "./slice.ts";

/** The scanner's per-row state. */
type Scanner = {
  /** The row's output assembly. */
  e: Emitter;
  /** The source row being scanned. */
  row: string;
  /** Character index into `row`. */
  i: number;
  /** The row's incoming carry (see rowCarry.ts). */
  carry: RowCarry;
  /** Inside a JSON string (possibly carried from the previous row). */
  inString: boolean;
  /** A backslash has armed an escape: the next character completes it. */
  escaped: boolean;
};

/** Emit `text` in `color` with a reset suffix (the common token case). */
function colored(scanner: Scanner, text: string, color: string): void {
  releaseHead(scanner.e, scanner.carry.pending);
  put(scanner.e, color + text + C.reset, false);
}

/** Copy plain content through, releasing the head first if needed. */
function plainText(scanner: Scanner, text: string): void {
  releaseHead(scanner.e, scanner.carry.pending);
  put(scanner.e, text, false);
}

/** Copy one ANSI escape sequence through untouched (never tokenized). */
function copyEscape(scanner: Scanner): void {
  const m = matchEscape(scanner.row.slice(scanner.i));
  if (m === undefined) {
    scanner.i += 1; // drop a bare ESC
    return;
  }
  put(scanner.e, m, !scanner.e.content); // escapes ride the head
  scanner.i += m.length;
}

/** Copy the current character through (plain content or escape-pair tail). */
function copyChar(scanner: Scanner): void {
  plainText(scanner, scanner.row[scanner.i] as string);
  scanner.i += 1;
}

/**
 * The row's character loop: dispatch each character to the first step that
 * owns its grammar. The STEP ORDER is the grammar's priority: escapes
 * first (they are never tokenized), then the held head's pad-run, then
 * string internals, then the flat token set; the plain copier is the
 * catch-all.
 */
type Step = (scanner: Scanner, ch: string) => boolean;

/** The dispatch chain, in grammar-priority order. */
const STEPS: readonly Step[] = [
  copyEscapeStep,
  headPadStep,
  inStringStep,
  backslashStep,
  escapedTailStep,
  indicatorStep,
  stringStep,
  numberOrLiteralStep,
  punctStep,
  copyCharStep,
];

function scanRow(scanner: Scanner): void {
  const { row } = scanner;
  while (scanner.i < row.length) {
    const ch = row[scanner.i] as string;
    const step = STEPS.find((apply) => apply(scanner, ch));
    if (step === undefined) break; // unreachable: copyCharStep always fits
  }
}

/** ANSI escapes are never tokenized: copied through whole. */
function copyEscapeStep(scanner: Scanner, ch: string): boolean {
  if (ch !== "\x1b") return false;
  copyEscape(scanner);
  return true;
}

/** Leading pad/indent spaces (before the first content char) ride the head. */
function headPadStep(scanner: Scanner, ch: string): boolean {
  if (scanner.e.content || ch !== " ") return false;
  put(scanner.e, ch, true);
  scanner.i += 1;
  return true;
}

/** The catch-all: copy one character of plain content through. */
function copyCharStep(scanner: Scanner, _ch: string): boolean {
  copyChar(scanner);
  return true;
}

/**
 * String-interior handling for one character; true when `ch` was consumed.
 * Inside a string everything copies verbatim — only an UNESCAPED quote
 * closes it (the `\"` escape pair passes through as content).
 */
function inStringStep(scanner: Scanner, ch: string): boolean {
  if (!scanner.inString) return false;
  if (ch === '"' && !scanner.escaped) {
    colored(scanner, ch, C.str);
    scanner.inString = false;
    scanner.i += 1;
    return true;
  }
  copyChar(scanner);
  // A backslash arms the escape (its pair tail rides as content); any
  // other in-string character disarms it.
  scanner.escaped = ch === "\\";
  return true;
}

/**
 * A backslash OUTSIDE a string. Within an escape pair it is the escaped
 * backslash itself (emitted plain, pair closed); otherwise it arms a new
 * escape pair — so `\\` is two plain backslashes and `\"` never opens a
 * string.
 */
function backslashStep(scanner: Scanner, ch: string): boolean {
  if (scanner.inString || ch !== "\\") return false;
  if (scanner.escaped) {
    scanner.escaped = false; // the pair's second backslash: plain
  } else {
    scanner.escaped = true; // arm the pair
  }
  copyChar(scanner);
  return true;
}

/** The second character of an armed escape pair outside a string: copied
 *  plain (this is what keeps `\"` from opening a string token). */
function escapedTailStep(scanner: Scanner, _ch: string): boolean {
  if (scanner.inString || !scanner.escaped) return false;
  scanner.escaped = false;
  copyChar(scanner);
  return true;
}

/** An indicator glyph (✓/✗ family) with its VS-16 selector folded in. */
function indicatorStep(scanner: Scanner, ch: string): boolean {
  if (!isIndicatorStart(ch)) return false;
  const ind = indicatorAt(scanner.row, scanner.i, ch);
  colored(scanner, ind.glyph, ind.color);
  scanner.i += ind.glyph.length;
  return true;
}

/**
 * A quote OUTSIDE a string: the start of a string token. Its color is
 * key when a colon follows the close quote (after optional blanks), else
 * string. When the string never closes on this row (a wrap split), the
 * token stays open — emitted WITHOUT a reset, so the color also covers
 * the string text of this row's tail and rides to the next row.
 */
function stringStep(scanner: Scanner, ch: string): boolean {
  if (ch !== '"') return false;
  const tok = openStringToken(scanner.row, scanner.i);
  if (tok.openEnd) {
    releaseHead(scanner.e, scanner.carry.pending);
    put(scanner.e, tok.color + tok.text, false); // no reset: color runs on
    scanner.inString = true;
  } else {
    colored(scanner, tok.text, tok.color);
  }
  scanner.i += tok.text.length;
  return true;
}

/** Punctuation: one of the JSON structure characters. */
function punctStep(scanner: Scanner, ch: string): boolean {
  if (!"{}[],:".includes(ch)) return false;
  colored(scanner, ch, C.punct);
  scanner.i += 1;
  return true;
}

/** A number or literal token at the cursor; false when neither matches
 *  (the caller then copies the character through as plain content). */
function numberOrLiteralStep(scanner: Scanner, ch: string): boolean {
  if (!"-0123456789tfn".includes(ch)) return false;
  const rest = scanner.row.slice(scanner.i);
  const num = matchNumber(rest);
  if (num !== undefined) {
    colored(scanner, num, C.num);
    scanner.i += num.length;
    return true;
  }
  const lit = matchLiteral(rest);
  if (lit === undefined) return false;
  // A literal must end at a non-word character (nullX is not null).
  const after = scanner.row[scanner.i + lit.length] ?? " ";
  if (/[A-Za-z0-9_]/.test(after)) return false;
  colored(scanner, lit, C.lit);
  scanner.i += lit.length;
  return true;
}

/** An OPEN string token: its colored text (to the close quote, or to the
 *  row end when the string splits across the wrap) and whether it is left
 *  open at the row end. */
type StringToken = { text: string; color: string; openEnd: boolean };

/** The string token starting at the quote at `start`: scans for the close
 *  quote while honoring backslash escapes (they cannot close a string). */
function openStringToken(row: string, start: number): StringToken {
  let j = start + 1;
  while (j < row.length) {
    const c = row[j] as string;
    if (c === "\\") {
      j += 2; // \" and \\ pass through: they cannot close the string
      continue;
    }
    if (c === '"') return closedToken(row, start, j + 1);
    j += 1;
  }
  return { text: row.slice(start), color: C.str, openEnd: true };
}

/** A closed string token ending at `end`: key-colored when a colon follows
 *  (after optional blanks — the JSON `"key": value` shape), else string. */
function closedToken(row: string, start: number, end: number): StringToken {
  let k = end;
  while (k < row.length && (row[k] === " " || row[k] === "\t")) k += 1;
  return {
    text: row.slice(start, end),
    color: (row[k] ?? "") === ":" ? C.key : C.str,
    openEnd: false,
  };
}

/** The outcome of scanning one row. */
export type RowScan = {
  /** The colored row. */
  out: string;
  /** Whether the row ENDED inside a string (the carry re-arms). */
  inString: boolean;
  /** Whether the row ended with a dangling (escaping) backslash. */
  escaped: boolean;
};

/**
 * Scan one row in the context of `carry` (its pending color gates the
 * head release; `escaped` seeds the row inside an escape pair when the
 * previous row ended with a dangling backslash). Returns the colored row
 * plus the end state the caller threads into the next row's carry.
 */
export function scanRowText(row: string, carry: RowCarry): RowScan {
  const scanner: Scanner = {
    e: { out: "", head: "", content: false },
    row,
    i: 0,
    carry,
    inString: carry.pending !== "",
    escaped: carry.escaped,
  };
  scanRow(scanner);
  return { out: scanner.e.out, inString: scanner.inString, escaped: scanner.escaped };
}
