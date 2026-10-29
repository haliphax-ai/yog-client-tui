/**
 * Colorize tool call-line content (compact JSON args, ✅/❌ indicators) with
 * lightweight syntax highlighting. ANSI-safe: escape sequences are copied
 * through untouched and plain runs are tokenized. Runs per display row: the
 * style's row prefix (pad + fg resets) is held and flushed first, then any
 * color carried from a string token split across a wrap is re-emitted — so
 * continuation rows keep their formatting. Escapes are honored: a \" never
 * opens or closes a string, and a string whose backslash sits against a
 * wrap split stays string-colored into the continuation row.
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
    let escapedInit = false; // escape state carried across a row split
    let i = 0;
    let inString = inStringInit; // string carried across a row split
    let escaped = false; // a backslash consumed an escape mid-scan
    // A backslash immediately before the newline escapes the quote that
    // would otherwise start the next row (JSON strings cannot contain a
    // literal newline): restart the continuation in escape state.
    if (escapedInit) {
      escapedInit = false;
      inString = true;
      escaped = true;
      pending = carry !== "" ? carry : C.str;
    }

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
      // An escape inside a string is copied verbatim (\" …); outside one,
      // a backslash escapes the next character (e.g. the \\" before a
      // wrapped-away quote) so the quote is not taken as a string opener.
      if (ch === "\\") {
        if (inString) {
          if (!headDone) flushHead();
          out += ch;
          escaped = true;
          i += 1;
          continue;
        }
        if (escaped) {
          // A backslash escaped by the previous backslash: emit it plain.
          escaped = false;
          if (!headDone) flushHead();
          out += ch;
          i += 1;
          continue;
        }
        // Start of an escape sequence: emitted together with the next char.
        escaped = true;
        i += 1;
        continue;
      }
      if (escaped && !inString) {
        // Second character of an escape sequence outside a string.
        escaped = false;
        if (!headDone) flushHead();
        out += ch;
        i += 1;
        continue;
      }
      if (inString) {
        // Inside a string (possibly carried from the previous row): copy
        // verbatim; only an unescaped " can close it. The second character
        // of an escape (e.g. the \" marker) passes through without closing.
        if (ch === '"' && !escaped) {
          colorize('"', C.str);
          inString = false;
          pending = "";
        } else {
          if (!headDone) flushHead();
          out += ch;
          escaped = false;
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
          // Closing quote of a string (including one carried across rows).
          colorize('"', C.str);
          inString = false;
          pending = "";
          i += 1;
          continue;
        }
        let j = i + 1;
        let closed = false;
        let danglingEscape = false;
        while (j < row.length) {
          const c = row[j] as string;
          if (c === "\\") {
            danglingEscape = true;
            j += 2; // \" and \\\\ pass through: they cannot close the string
            continue;
          }
          danglingEscape = false;
          if (c === '"') {
            closed = true;
            j += 1;
            break;
          }
          j += 1;
        }
        if (closed) {
          let k = j;
          while (k < row.length && (row[k] === " " || row[k] === "\\t")) k += 1;
          colorize(row.slice(i, j), row[k] === ":" ? C.key : C.str);
          i = j;
          continue;
        }
        // Open at row end (wrap split): color to end, re-emit next row.
        colorize(row.slice(i), C.str, true);
        inString = true;
        // A trailing backslash escapes the (display-wrapped-away) quote
        // before the newline: the continuation row starts inside the
        // escaped character, mid-string.
        escapedInit = danglingEscape;
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