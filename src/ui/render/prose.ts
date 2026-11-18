/**
 * Entry-prose markdown rendering: per-paragraph glamour documents.
 *
 * The glamour primitives live in markdown.ts (the leaf the table engine
 * also uses); this module composes them for the entry renderer. Its only
 * upward import is `paragraphGroups` from table/parse.ts — a one-way edge
 * to the table engine's splitter — and its only consumer is entry.ts, so
 * no render-module cycle exists. The SGR flattening for the prompt bubble
 * lives in sgr.ts ({@link flattenRow}).
 */
import { hangWrapRows, mdRender, normalizeLines } from "./markdown.ts";
import { paragraphGroups, type ParagraphGroup } from "./table/parse.ts";
import { wrapText } from "../../util/ansi.ts";
import { flattenRow } from "./sgr.ts";

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
