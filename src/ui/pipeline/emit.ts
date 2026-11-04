/**
 * Emit stage: the single owner of frame writes. The pipeline's emit stage
 * funnels every write through `writeFrame` here — nothing else in the code
 * base writes composed frames to stdout.
 */
/** Clear the whole screen so no stale cells survive from earlier frames
 *  (overlong continuation rows, shrunken rows, scrolled aliasing). */
const CLEAR_FULL = "\x1b[2J";
/** Cursor-home prefix so every frame repaints from the top-left. */
const HOME = "\x1b[H";
/** Erase-below: wipe any rows the previous frame painted that this frame does
 *  not cover (overlong rows, shorter frames). */
const ERASE_BELOW = "\x1b[J";

/** Write one composed frame (full clear + cursor home + "\r\n"-joined lines). */
export function writeFrame(frame: string): void {
  process.stdout.write(`${CLEAR_FULL}${HOME}${frame.split("\n").join("\r\n")}${ERASE_BELOW}`);
}
