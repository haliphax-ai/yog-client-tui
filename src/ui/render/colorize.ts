/**
 * Colorize tool call-line content (compact JSON args, ✅/❌ indicators) with
 * lightweight syntax highlighting. ANSI-safe: escape sequences are copied
 * through untouched and plain runs are tokenized. Runs per display row: the
 * style's row prefix (pad + fg resets) is held and flushed first, then any
 * color carried from a string token split across a wrap is re-emitted — so
 * continuation rows keep their formatting.
 */
import { C } from "../theme.ts";

/** Matches one ANSI escape sequence at the current position, if any. */
const ESC =
  /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|^\x1b\[[0-9;?]*[ -/]*[@-~]|^\x1b[@-Z\\-_]/;

export function colorizeToolLine(text: string): string {
  let pending = ""; // open token color carried across a row split
  const outRows: string[] = [];

  for (const row of text.split("\n")) {
    let out = "";
    let head = ""; // held row prefix: style escapes + pad/indent spaces
    let headDone = false;
    const carry = pending;
    pending = "";
    const inStringInit = carry !== "";
    if (inStringInit) pending = carry; // keep the string color alive
    let i = 0;
    let inString = inStringInit; // string carried across a row split

    const flushHead = (): void => {
      out += head;
      head = "";
      if (carry) out += carry; // after the prefix, before the content
      headDone = true;
    };
    const colorize = (token: string, color: string, open = false): void => {
      if (!headDone) flushHead();
      out += color + token + (open ? "" : C.reset);
      if (open) pending = color;
    };
    const escape = (): void => {
      const m = row.slice(i).match(ESC);
      if (m) {
        if (headDone) out += m[0];
        else head += m[0];
        i += m[0].length;
      } else {
        i += 1; // drop a bare ESC
      }
    };

    while (i < row.length) {
      const ch = row[i] as string;
      if (ch === "\x1b") {
        escape();
        continue;
      }
      if (!headDone) {
        if (ch === " ") {
          head += ch; // prefix pad / content indent
          i += 1;
          continue;
        }
        flushHead();
      }
      if (inString) {
        // String continued from the previous row: keep carry color, skip
        // tokenization; only a \" can close it.
        if (ch === '"') {
          colorize('"', C.str);
          inString = false;
          pending = "";
        } else {
          out += ch;
        }
        i += 1;
        continue;
      }
      if (ch === "✅" || ch === "❌" || ch === "✓" || ch === "✗") {
        let end = i + 1;
        if (row[end] === "\uFE0F") end += 1;
        colorize(row.slice(i, end), ch === "✅" || ch === "✓" ? C.ok : C.fail);
        i = end;
        continue;
      }
      if (ch === '"') {
        if (inString) {
          // Closing quote of a string carried across rows.
          colorize('"', C.str);
          inString = false;
          pending = "";
          i += 1;
          continue;
        }
        let j = i + 1;
        let closed = false;
        while (j < row.length) {
          const c = row[j] as string;
          if (c === "\\") {
            j += 2;
            continue;
          }
          if (c === '"') {
            closed = true;
            j += 1;
            break;
          }
          j += 1;
        }
        if (closed) {
          let k = j;
          while (k < row.length && (row[k] === " " || row[k] === "\t")) k += 1;
          colorize(row.slice(i, j), row[k] === ":" ? C.key : C.str);
          i = j;
          continue;
        }
        // Open at row end (wrap split): color to end, re-emit next row.
        colorize(row.slice(i), C.str, true);
        inString = true;
        i = row.length;
        continue;
      }
      const num = row.slice(i).match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (num) {
        colorize(num[0], C.num);
        i += num[0].length;
        continue;
      }
      const lit = row.slice(i).match(/^(?:true|false|null)/);
      if (lit && /[^A-Za-z0-9_]/.test(row[i + lit[0].length] ?? " ")) {
        colorize(lit[0], C.lit);
        i += lit[0].length;
        continue;
      }
      if ("{}[],:".includes(ch)) {
        colorize(ch, C.punct);
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
    }
    if (!headDone && head !== "") out += head; // prefix-only row
    outRows.push(out);
  }
  return outRows.join("\n");
}