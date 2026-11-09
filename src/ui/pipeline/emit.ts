/**
 * Emit stage: the single owner of frame writes. The pipeline's emit stage
 * funnels every write through `writeFrame` here — nothing else in the code
 * base writes composed frames to stdout.
 *
 * Frames are DIFF-painted against the previous frame's rows. Row N of a
 * frame is always terminal row N (the previous frame is exactly terminal
 * height), so a changed row is reached with cursor-home plus one CRLF per
 * row above it; unchanged rows contribute separator CRLFs only — no bytes
 * of content. Rows after the last changed row are not touched at all, so
 * the write never ends in a CRLF (which would scroll at the bottom row).
 * No-op keystrokes write nothing; typing writes only the input row's
 * transit. The post stage pads every line to exactly the terminal width,
 * so writing a changed row's full-width content overwrites it completely.
 */
const HOME = "\x1b[H";

/** Last written frame's lines (null = next write repaints everything). */
let lastLines: string[] | null = null;

/** Forget the cached frame: the next write is a full repaint. Call on
 *  resize: the terminal has reflowed its rows, so the old diff baseline
 *  is meaningless. The host no longer blanks first (#67) — the full
 *  repaint below *is* the swap, with no intermediate blank frame. */
export function resetFrameCache(): void {
  lastLines = null;
}

/** Write one composed frame. Changed rows only, in absolute position. */
export function writeFrame(frame: string): void {
  const lines = frame.split("\n");
  const prev = lastLines;
  lastLines = lines;
  if (prev === null) {
    process.stdout.write(`${HOME}${lines.join("\r\n")}`);
    return;
  }
  const shared = Math.min(lines.length, prev.length);
  let lastChanged = -1;
  for (let i = 0; i < shared; i++) {
    if (prev[i] !== lines[i]) lastChanged = i;
  }
  if (lines.length > prev.length) lastChanged = lines.length - 1; // new rows
  if (lastChanged === -1) {
    if (lines.length < prev.length) process.stdout.write("\x1b[J");
    return;
  }
  const out: string[] = [HOME];
  for (let i = 0; i <= lastChanged; i++) {
    if (i > 0) out.push("\r\n"); // transit: unchanged rows just advance
    if (i < shared && prev[i] === lines[i]) continue; // unchanged: no bytes
    out.push(lines[i] ?? "");
  }
  process.stdout.write(out.join(""));
  if (lines.length < prev.length) process.stdout.write("\x1b[J");
}
