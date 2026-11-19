/**
 * Terminal escape-sequence → textarea key-event translation for the input
 * bar.
 *
 * The two app-level carve-outs (Shift+Enter newline, Shift+Up ring handoff)
 * are matched in `InputComponent` as sequence sets; everything else decodes
 * to a `SeqKey` the textarea model already binds: CSI letter/`~`/`u` finals
 * with the xterm modifier byte, and the legacy (non-CSI) SS3 / Alt+letter
 * escapes some terminals still send.
 */
import { KeyCode, KeyMod } from "@oakoliver/bubbletea";

/** A key event fed to the textarea model (shape of bubbletea's `Key`). */
interface SeqKey {
  readonly text?: string;
  readonly mod?: number;
  readonly code: number;
}

/**
 * Legacy (non-CSI) sequences the input claims: SS3 application-mode arrows
 * (ESC O x) and the Alt+letter escapes some terminals still send for word
 * navigation / case transforms.
 */
const LEGACY_SEQ_KEYS: Readonly<Record<string, SeqKey>> = {
  "\x1bOA": { code: KeyCode.Up },
  "\x1bOB": { code: KeyCode.Down },
  "\x1bOC": { code: KeyCode.Right },
  "\x1bOD": { code: KeyCode.Left },
  "\x1bOH": { code: KeyCode.Home },
  "\x1bOF": { code: KeyCode.End },
  "\x1b[1~": { code: KeyCode.Home }, // rxvt
  "\x1b[4~": { code: KeyCode.End }, // rxvt
  "\x1b[3~": { code: KeyCode.Delete },
  "\x1bb": { code: KeyCode.Left, mod: KeyMod.Alt }, // alt+left
  "\x1bf": { code: KeyCode.Right, mod: KeyMod.Alt }, // alt+right
  "\x1bc": { code: 99, mod: KeyMod.Alt }, // alt+c
  "\x1bl": { code: 108, mod: KeyMod.Alt }, // alt+l
  "\x1bu": { code: 117, mod: KeyMod.Alt }, // alt+u
  "\x1bd": { code: 100, mod: KeyMod.Alt }, // alt+d
  "\x1b<": { code: 60, mod: KeyMod.Alt }, // alt+<
  "\x1b>": { code: 62, mod: KeyMod.Alt }, // alt+>
  "\x1bF": { code: 70, mod: KeyMod.Alt | KeyMod.Shift }, // alt+shift+f
  "\x1bB": { code: 66, mod: KeyMod.Alt | KeyMod.Shift }, // alt+shift+b
};

/** Modifier bits for a CSI parameter byte (xterm encoding: value-1 is a
 *  shift+alt+ctrl bitmask; 0/absent means no modifiers). */
function modFor(param: number): number {
  const bits = param - 1;
  if (bits < 0 || bits > 7) return KeyMod.None;
  return (
    ((bits & 1) !== 0 ? KeyMod.Shift : KeyMod.None) |
    ((bits & 2) !== 0 ? KeyMod.Alt : KeyMod.None) |
    ((bits & 4) !== 0 ? KeyMod.Ctrl : KeyMod.None)
  );
}

/** Key code for a CSI-u (Kitty) code point: control chars, space, arrows,
 *  Home/End. Other code points are printable — the textarea types them. */
const CSI_U_CODES: ReadonlyMap<number, number> = new Map([
  [13, KeyCode.Enter],
  [8, KeyCode.Backspace],
  [127, KeyCode.Backspace],
  [9, KeyCode.Tab],
  [27, KeyCode.Escape],
  [32, KeyCode.Space],
  [65, KeyCode.Up],
  [66, KeyCode.Down],
  [67, KeyCode.Right],
  [68, KeyCode.Left],
  [70, KeyCode.End],
  [72, KeyCode.Home],
]);

/** The final byte's key code for the letter forms (arrows, Home/End). */
const FINAL_LETTER_CODES: ReadonlyMap<string, number> = new Map([
  ["A", KeyCode.Up],
  ["B", KeyCode.Down],
  ["C", KeyCode.Right],
  ["D", KeyCode.Left],
  ["H", KeyCode.Home],
  ["F", KeyCode.End],
]);

/** The key code for a `~`-final sequence's kind (Home/End/Delete/PgUp/PgDn). */
const TILDE_KIND_CODES: ReadonlyMap<number, number> = new Map([
  [1, KeyCode.Home],
  [3, KeyCode.Delete],
  [4, KeyCode.End],
  [5, KeyCode.PgUp],
  [6, KeyCode.PgDown],
]);

/** The keyed table for a parameterized final byte (`~` kinds, `u` code
 *  points); undefined for finals that take no parameter. */
function paramTableFor(final: string): ReadonlyMap<number, number> | undefined {
  if (final === "~") return TILDE_KIND_CODES;
  return final === "u" ? CSI_U_CODES : undefined;
}

/** The key code a parsed CSI final byte resolves to; undefined for finals
 *  the textarea does not bind. */
function codeForFinal(final: string, params: number[]): number | undefined {
  const letter = FINAL_LETTER_CODES.get(final);
  if (letter !== undefined) return letter;
  const kind = params[0];
  return kind === undefined ? undefined : paramTableFor(final)?.get(kind);
}

/**
 * Parse a CSI sequence (ESC [ params final) into a key event: arrows, Home/
 * End (C and `~` forms), PgUp/PgDn, Delete, Backspace, Enter, Tab, Esc —
 * each with its modifier bits. Returns undefined for sequences the textarea
 * does not bind (unknown finals, printable/other CSI-u code points).
 */
function parseSeqKey(seq: string): SeqKey | undefined {
  if (!seq.startsWith("\x1b[")) return undefined;
  const match = /^([\d;]*)([A-Za-z~])$/.exec(seq.slice(2));
  if (match === null) return undefined;
  const params = (match[1] as string) === "" ? [] : (match[1] as string).split(";").map(Number);
  const code = codeForFinal(match[2] as string, params);
  if (code === undefined) return undefined;
  const mod = params.length >= 2 ? modFor(params[1] ?? 0) : KeyMod.None;
  return { code, mod };
}
export { type SeqKey, parseSeqKey, LEGACY_SEQ_KEYS };
