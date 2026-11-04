/**
 * Emit stage: the single owner of frame writes. The pipeline's emit stage
 * funnels every write through `writeFrame` here — nothing else in the code
 * base writes composed frames to stdout.
 *
 * Frames are DIFF-painted: each frame's rows are compared against the last
 * frame's rows and only changed rows are written (cursor-home + one CRLF per
 * row). Unchanged rows cost nothing on the wire, which removes the flicker
 * of full-screen repaints on no-op keystrokes and typing (only the input row
 * changes). The previous frame height equals the terminal height, so row N of
 * this frame is always terminal row N — diffing by index is absolute.
 */
const HOME = "\x1b[H";

/** Last written frame's lines (null = next write repaints everything). */
let lastLines: string[] | null = null;

/** Forget the cached frame: the next write is a full repaint. Call on
 *  resize (the host clears the screen; the diff baseline is gone). */
export function resetFrameCache(): void {
  lastLines = null;
}

/** Write one composed frame. Changed rows only; a shrunken frame clears
 *  the rows it no longer covers. No trailing CRLF: a CRLF written while the
 *  cursor sits on the terminal's last row would scroll the screen. */
export function writeFrame(frame: string): void {
  const lines = frame.split("\n");
  const prev = lastLines;
  lastLines = lines;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (prev !== null && i < prev.length && prev[i] === line) continue;
    out.push(line);
  }
  // Trailing skipped rows write nothing — drop them so the join never ends
  // in a CRLF (which would push the cursor past the last row and scroll).
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  if (out.length > 0) {
    process.stdout.write(`${HOME}${out.join("\r\n")}`);
  }
  if (prev !== null && lines.length < prev.length) {
    // The frame shrank (e.g. the autocomplete menu closed and the layout
    // grew the viewport back): erase the rows below the new frame.
    process.stdout.write("\x1b[J");
  }
}
