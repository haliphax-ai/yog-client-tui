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

/** The paste framing state that persists across chunks: inside a paste,
 *  everything (sequences included) buffers verbatim until the end marker. */
interface PasteBuffer {
  pasting: boolean;
  content: string;
}

/** A sequence seen while pasting: the end marker flushes the buffer (one
 *  `onPasteEnd`), everything else accumulates literally. */
function consumePastedSequence(pb: PasteBuffer, handlers: InputHandlers, seq: string): void {
  if (seq !== PASTE_END) {
    pb.content += seq;
    return;
  }
  pb.pasting = false;
  const content = pb.content;
  pb.content = "";
  handlers.onPasteEnd(content);
}

/** One well-formed escape sequence at the head of the unconsumed input. */
function consumeSequence(pb: PasteBuffer, handlers: InputHandlers, seq: string): void {
  if (pb.pasting) {
    consumePastedSequence(pb, handlers, seq);
    return;
  }
  if (seq === PASTE_START) {
    pb.pasting = true;
    pb.content = "";
    return;
  }
  handlers.onSequence(seq);
}

/** One decoded character at the head of the unconsumed input: buffered
 *  verbatim inside a paste, dispatched to `onChar` otherwise. */
function consumeChar(pb: PasteBuffer, handlers: InputHandlers, ch: string): void {
  if (pb.pasting) {
    pb.content += ch;
    return;
  }
  handlers.onChar(ch);
}

/**
 * A streaming decoder for stdin chunks. Paste framing state (in-paste flag,
 * buffer) persists across chunks so a paste split over several `data` events
 * is still reassembled correctly.
 */
export function createInputDecoder(handlers: InputHandlers): (chunk: string) => void {
  const pb: PasteBuffer = { pasting: false, content: "" };
  return (chunk: string): void => {
    let i = 0;
    while (i < chunk.length) {
      const rest = chunk.slice(i);
      const seq = matchSequence(rest);
      if (seq !== null) {
        consumeSequence(pb, handlers, seq);
        i += seq.length;
        continue;
      }
      const cp = rest.codePointAt(0);
      if (cp === undefined) break;
      const ch = String.fromCodePoint(cp);
      consumeChar(pb, handlers, ch);
      i += ch.length;
    }
  };
}
