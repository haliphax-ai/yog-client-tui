/**
 * Emit stage: the single owner of frame writes. The pipeline's emit stage
 * funnels every write through `writeFrame` here — nothing else in the code
 * base writes composed frames to stdout.
 */
/** Cursor-home prefix so every frame repaints from the top-left. */
const HOME = "\x1b[H";

/** Write one composed frame (cursor home + "\r\n"-joined lines) to stdout. */
export function writeFrame(frame: string): void {
  process.stdout.write(`${HOME}${frame.split("\n").join("\r\n")}`);
}