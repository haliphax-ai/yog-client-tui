/**
 * Raw stdin decoding for the TUI: escape sequences, single characters, and
 * bracketed-paste framing. The composition root feeds each `data` chunk
 * through a decoder created by {@link createInputDecoder}; the decoder turns
 * the byte stream into high-level events (sequences, chars, paste end).
 *
 * Bracketed paste (`ESC[?2004h`) wraps pasted text in `ESC[200~` ... `ESC[201~`
 * markers. Everything between the markers is buffered as a single paste and
 * delivered as one `onPasteEnd(content)` event — pasted newlines therefore
 * never travel through the char/key path (they can't trigger a submit).
 */

/** Decoder callbacks (wired by the composition root). */
export interface InputHandlers {
  /** A well-formed escape sequence (arrows, Shift+Tab, Shift+Enter, …). */
  onSequence(seq: string): void;
  /** One decoded character (printable or control such as `\r`, `\t`). */
  onChar(ch: string): void;
  /** A bracketed paste finished; `content` is the literal pasted text. */
  onPasteEnd(content: string): void;
}

/** Bracketed-paste start marker. */
export const PASTE_START = "\x1b[200~";

/** Bracketed-paste end marker. */
export const PASTE_END = "\x1b[201~";

/**
 * Longest well-formed escape sequence at the start of `rest` (CSI `ESC [`
 * or SS3 `ESC O`, parameter bytes up to a final byte); null when the rest
 * starts with plain input or a lone/incomplete escape.
 */
export function matchSequence(rest: string): string | null {
  if (!rest.startsWith("\x1b") || rest.length < 2) return null;
  const kind = rest[1];
  if (kind !== "[" && kind !== "O") return null;
  for (let j = 2; j < rest.length; j += 1) {
    const c = rest.charCodeAt(j);
    if (c >= 0x30 && c <= 0x3f) continue; // parameter bytes
    if (c >= 0x40 && c <= 0x7e) return rest.slice(0, j + 1); // final byte
    return null;
  }
  return null; // incomplete at the end of this chunk
}

/**
 * A streaming decoder for stdin chunks. Paste framing state (in-paste flag,
 * buffer) persists across chunks so a paste split over several `data` events
 * is still reassembled correctly.
 */
export function createInputDecoder(handlers: InputHandlers): (chunk: string) => void {
  let pasting = false;
  let pasteBuffer = "";
  return (chunk: string): void => {
    let i = 0;
    while (i < chunk.length) {
      const rest = chunk.slice(i);
      const seq = matchSequence(rest);
      if (seq !== null) {
        if (pasting) {
          if (seq === PASTE_END) {
            pasting = false;
            const content = pasteBuffer;
            pasteBuffer = "";
            handlers.onPasteEnd(content);
          } else {
            pasteBuffer += seq;
          }
          i += seq.length;
          continue;
        }
        if (seq === PASTE_START) {
          pasting = true;
          pasteBuffer = "";
          i += seq.length;
          continue;
        }
        handlers.onSequence(seq);
        i += seq.length;
        continue;
      }
      const cp = rest.codePointAt(0);
      if (cp === undefined) break;
      const ch = String.fromCodePoint(cp);
      if (pasting) {
        pasteBuffer += ch;
        i += ch.length;
        continue;
      }
      handlers.onChar(ch);
      i += ch.length;
    }
  };
}
