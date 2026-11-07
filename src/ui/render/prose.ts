/**
 * Entry-prose markdown rendering: per-paragraph glamour documents.
 *
 * The glamour primitives live in markdown.ts (the leaf the table engine
 * also uses); this module composes them for the entry renderer. Its only
 * upward import is `paragraphGroups` from table/parse.ts — a one-way edge
 * to the table engine's splitter — and its only consumer is entry.ts, so
 * no render-module cycle exists.
 */
import { hangWrapRows, mdRender, normalizeLines } from "./markdown.ts";
import { paragraphGroups, type ParagraphGroup } from "./table/parse.ts";
import { wrapText } from "../../util/ansi.ts";

/**
 * Flatten glamour's theme colors out of a rendered markdown row, keeping
 * only structural emphasis (bold/italic): inside the prompt bubble the role
 * style (light-grey text on light-grey bg) must win, and background resets
 * would punch holes in it. Glamour emits colors in combined SGRs in TWO
 * orders:
 *
 *  - `renderText` (element styling): color parts lead — `38;2;r;g;b;3` —
 *    with attributes trailing.
 *  - `Pen.toString` (the wrap writer's per-row state re-emit at soft-wrap
 *    points): attributes lead — `3;38;2;r;g;b` — with colors trailing.
 *
 * The wrap re-emit is the one that lands at CONTINUATION-row starts, so
 * missing the attr-leading form leaks glamour's theme fg (tokyo-night
 * blue-grey) into the bubble on every wrapped row and lets emphasis drift
 * into subsequent runs. Both orders are flattened the same way: every color
 * part (fg/bg/underline-color, 256- or truecolor) is dropped, attribute
 * parts (bold 1, italic 3, …) are re-emitted standalone, and a SGR of
 * nothing but colors is dropped entirely. Closing resets become attr-off
 * codes so emphasis never leaks past its run. Assistant replies keep
 * glamour's full styling.
 */
export function flattenRow(row: string): string {
  return row
    .replaceAll("\x1b[m", "\x1b[23m\x1b[22m")
    .replaceAll("\x1b[0m", "\x1b[23m\x1b[22m")
    .replace(
      // eslint-disable-next-line no-control-regex
      /\x1b\[([0-9;]*)m/g,
      (_m, params: string) => {
        const parts = params.split(";");
        const attrs: string[] = [];
        for (let i = 0; i < parts.length; i++) {
          const code = parts[i] as string;
          // Extended color parts: 38/48/58 consume 3 or 5 params — skip
          // them entirely (colors are flattened away).
          if (code === "38" || code === "48" || code === "58") {
            i += (parts[i + 1] === "2" ? 5 : 3) - 1;
            continue;
          }
          // Attribute parts survive; color shorthand (30-37/90-97 fg,
          // 40-47/100-107 bg) and color resets (39/49/59) are dropped.
          if (
            /^(?:[1-9]|[1-9][0-9])$/.test(code) &&
            !/^(?:3[0-9]|4[0-9]|9[0-7]|10[0-7])$/.test(code)
          ) {
            attrs.push(code);
          }
        }
        return attrs.length > 0 ? `\x1b[${attrs.join(";")}m` : "";
      },
    );
}

/** One paragraph group rendered through glamour and normalized per the
 *  caller's row shaper; undefined = glamour failed (plain fallback). */
function renderGroup(
  group: ParagraphGroup,
  cols: number,
  shape: (rendered: string, cols: number, source: string) => string[],
): string[] | undefined {
  const source = group.lines.join("\n");
  const rendered = mdRender(source, cols);
  if (rendered === "") return undefined;
  return shape(rendered, cols, source);
}

/** Per-paragraph variant of markdown's renderMarkdown for the entry
 *  renderer: each paragraph group renders as its own glamour document so
 *  its list indent is assigned from its own first block (a leading
 *  paragraph would anchor ONE shared indent to zero and eat the list
 *  indent — which flushed nested sublists against their parents). A group
 *  renders STYLED when its own glamour pass succeeds and PLAIN
 *  (word-wrapped verbatim) when it fails or the input is oversized — one
 *  bad group no longer flattens its whole section. */
export function renderMarkdownFlat(text: string, cols: number): string[] {
  if (text.length > 100_000) return wrapText(text, cols);
  const out: string[] = [];
  for (const [gi, group] of paragraphGroups(text).entries()) {
    if (gi > 0) out.push(""); // the paragraph break between groups
    const rows = renderGroup(group, cols, normalizeLines);
    if (rows === undefined) {
      out.push(
        ...hangWrapRows(
          group.lines.flatMap((l) => wrapText(l, cols)),
          cols,
        ),
      );
      continue;
    }
    out.push(...hangWrapRows(rows, cols));
  }
  return out;
}

/** Per-paragraph variant of the prompt-bubble renderer: same group
 *  independence as {@link renderMarkdownFlat}, with the bubble's
 *  attribute-only flattening applied to every styled row (a plain group
 *  needs no flattening — wrapText emits no colors). */
export function flattenMarkdownFlat(text: string, cols: number): string[] {
  if (text.length > 100_000) return wrapText(text, cols);
  const out: string[] = [];
  for (const [gi, group] of paragraphGroups(text).entries()) {
    if (gi > 0) out.push(""); // the paragraph break between groups
    const rows = renderGroup(group, cols, normalizeLines);
    if (rows === undefined) {
      out.push(
        ...hangWrapRows(
          group.lines.flatMap((l) => wrapText(l, cols)),
          cols,
        ),
      );
      continue;
    }
    out.push(...hangWrapRows(rows, cols).map((row) => flattenRow(row)));
  }
  return out;
}
