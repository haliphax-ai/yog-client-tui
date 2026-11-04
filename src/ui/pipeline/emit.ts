/**
 * Emit stage: the single owner of frame writes. The pipeline's emit stage
 * funnels every write through `writeFrame` here — nothing else in the code
 * base writes composed frames to stdout.
 */
/** Cursor-home prefix so every frame repaints from the top-left. */
const HOME = "\x1b[H";
/** Erase-below: wipe any rows the previous frame painted that this frame does
 *  not cover (soft-wrapped overflow, shorter frames). */
const ERASE_BELOW = "\x1b[J";

/** Write one composed frame (cursor home + "\r\n"-joined lines) to stdout. */
export function writeFrame(frame: string): void {
  process.stdout.write(`${HOME}${frame.split("\n").join("\r\n")}${ERASE_BELOW}`);
}
