/**
 * Output assembly for the tool-line colorizer.
 *
 * A styled row arrives with a prefix of escape sequences and pad spaces
 * (the block style's geometry), and that prefix must stay AHEAD of any
 * token color: a token-colored fragment released before the prefix would
 * put its color reset between the pad and the style's own foreground,
 * corrupting the row. So the colorizer HOLDS the prefix ("head") until
 * the first content character, then releases it — re-emitting the
 * previous row's carried string color in between, so a string token
 * split across a wrap keeps its color on the continuation row.
 */

/** One row's output state: the held prefix plus the colored body. */
export type Emitter = {
  /** The colored row so far. */
  out: string;
  /** The held row prefix: leading escapes and pad spaces. */
  head: string;
  /** Whether content has started (the prefix has been released). */
  content: boolean;
};

/** A fresh row: nothing held, nothing emitted. */
export const newEmitter = (): Emitter => ({ out: "", head: "", content: false });

/** Append `text` to the held prefix (before content starts) or the body. */
export function put(e: Emitter, text: string, toHead: boolean): void {
  if (toHead) e.head += text;
  else e.out += text;
}

/**
 * Release the held prefix ahead of the first content: prefix first, then
 * the carried string color (`carry`; "" when none). A no-op once content
 * has started, so callers never need "already released" bookkeeping.
 */
export function releaseHead(e: Emitter, carry: string): void {
  if (e.content) return;
  e.out += e.head;
  e.head = "";
  if (carry !== "") e.out += carry;
  e.content = true;
}

/** Emit a prefix-only row: nothing but the prefix followed the head. */
export const releaseHeadAlone = (e: Emitter): void => {
  if (!e.content) e.out += e.head;
  e.head = "";
};
