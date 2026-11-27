/**
 * Frame line helpers shared by the pipeline stages: a frame is a "\n"-joined
 * string whose lines are padded (or truncated) to exactly `width` cells with
 * ANSI-aware measurement. Every produced row is already hard-wrapped to the
 * terminal width, so truncation here is only a safety net for any straggler.
 */
import { displayWidth, stripAnsi, truncateAnsi } from "../../util/index.ts";

/** The composed frame lines (pre-pad) produced by the paint stage. */
export type FrameLines = readonly string[];

/** Pad (or truncate) an ANSI-bearing line to exactly `width` cells. */
export function padLine(line: string, width: number): string {
  const w = displayWidth(line);
  if (w === width) return line;
  if (w > width) return truncateAnsi(line, width);
  return line + " ".repeat(width - w);
}

/** Normalize every line of a "\n"-joined frame to exactly `width` cells. */
export function padFrame(frame: string, width: number): string {
  return frame
    .split("\n")
    .map((line) => padLine(line, width))
    .join("\n");
}

/**
 * Compose the main pane rows (log viewport + drawer + input + status).
 *
 * Exactly one blank line separates the log from what follows it. When the
 * drawer is visible, that blank is the drawer's own top padding: the
 * viewport's trailing blank (the log's entry separator, or padding for
 * short content) is consumed so it does not stack with the padding into
 * exact row accounting: the viewport's row budget (see `viewportRows` in
 * main.ts) already subtracts the drawer's rows, and the drawer's padding
 * row is the visual gap between log and input. The pane is the plain
 * concatenation — no slicing, no blanking, no row donation anywhere;
 * any of those shifted the pane by a line and jittered the bubbles.
 */
export function composeMainPane(
  viewportRows: readonly string[],
  drawerRows: readonly string[],
  inputRow: string,
  statusRow: string,
): string[] {
  // The pane is exact accounting: viewportRows() already reserves the
  // drawer's rows, so the pane is the plain concatenation — no slicing, no
  // blanking. Any row-donation here shifted the whole pane by a line
  // (bubbles lost their top pad; two pads stacked at the bottom).
  //
  // ONE exception: the log's trailing separator blank and the drawer's top
  // retained blank (the spinner's idle row, #145) are ADJACENT blank rows
  // that read as a doubled gap between the log and the drawer's first real
  // row. The retained blank is load-bearing (it keeps the busy edge from
  // shifting rows), so the LOG's separator donates its slot instead: trim
  // one trailing viewport blank when the drawer's first row is blank. The
  // seam then reads as a single gap in both states.
  const drawerTop = drawerRows[0];
  const drawerTopBlank =
    drawerTop !== undefined && drawerTop.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").trim() === "";
  const vp = [...viewportRows];
  if (drawerTopBlank && vp.length > 1) {
    const last = vp[vp.length - 1] as string;
    if (last.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").trim() === "") {
      vp.pop();
      // The donated row stays in the pane as top pad (the content is
      // bottom-aligned): the pane height is exact, the seam reads single.
      vp.unshift("");
    }
  }
  return [...vp, ...drawerRows, inputRow, statusRow];
}
