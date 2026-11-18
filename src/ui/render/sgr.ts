/**
 * SGR (Select Graphic Rendition) flattening for the prompt bubble.
 *
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
 * nothing but colors is dropped entirely. The bare closing resets are
 * rewritten to attr-off codes up front so emphasis never leaks past its
 * run. Assistant replies keep glamour's full styling.
 */

/** What one SGR parameter does: an attribute to keep, a color to drop, or
 *  an extended color to skip past (with the parameter count it consumes). */
type SgrPart =
  | { readonly kind: "attr"; readonly code: string }
  | { readonly kind: "color" }
  | { readonly kind: "extended"; readonly params: number };

/** The 2-digit color shorthands (fg 30-37/90-97, bg 40-47/100-107) and the
 *  color resets (39/49/59) — every other 1-2-digit code is an attribute. */
const COLOR_CODE = /^(?:[1-9]|[1-9][0-9])$/;
const COLOR_SHORTHAND = /^(?:3[0-9]|4[0-9]|9[0-7]|10[0-7]|39|49|59)$/;

/** Classify one SGR parameter. */
function classify(code: string): SgrPart {
  if (code === "38" || code === "48" || code === "58") {
    // Extended colors are flattened away, so the whole color run (3 or 5
    // parameters — decided by the look-ahead in the caller) is skipped.
    return { kind: "extended", params: 3 };
  }
  if (COLOR_CODE.test(code) && !COLOR_SHORTHAND.test(code)) {
    return { kind: "attr", code };
  }
  return { kind: "color" };
}

/** Rewrite one combined SGR's parameters into the attribute-only form. */
function flattenSgr(params: string): string {
  const parts = params.split(";");
  const attrs: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = classify(parts[i] as string);
    if (part.kind === "extended") {
      i += (parts[i + 1] === "2" ? 5 : 3) - part.params;
      continue;
    }
    if (part.kind === "attr") attrs.push(part.code);
  }
  return attrs.length > 0 ? `\x1b[${attrs.join(";")}m` : "";
}

export function flattenRow(row: string): string {
  return (
    row
      .replaceAll("\x1b[m", "\x1b[23m\x1b[22m")
      .replaceAll("\x1b[0m", "\x1b[23m\x1b[22m")
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[([0-9;]*)m/g, (_m, params: string) => flattenSgr(params))
  );
}
