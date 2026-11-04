/**
 * Input bar: prompt marker + text window with a highlighted cursor, plus all
 * input-editing key handling (chars, cursor moves, delete). Reads the input
 * buffer / cursor / window scroll from the store and signals edits back via
 * `setState` — the store stays the single source of truth.
 *
 * Key handling is scoped by focus: the router offers keys to the focused
 * component first, then the remaining components, then the global bindings.
 * The input claims every editing key whenever it is reached (focused or
 * not); submit and Esc bubble up so the globals and the viewport can
 * claim them first. Tab completes a slash command when the line starts
 * with "/", otherwise bubbles to the focus-cycling global. Ctrl+C is
 * intentionally unbound (inert).
 *
 * Every width here is measured in terminal CELLS. The cursor highlights
 * the character under it — which may be a wide rune (an emoji is one
 * character but two cells) — so the text after the cursor is capped by the
 * cursor's own cell width, not by one assumed cell.
 */
import { joinHorizontal, Left } from "@oakoliver/lipgloss";
import { BaseComponent, type RenderContext } from "./Component.ts";
import { getState, setState } from "../../core/store.ts";
import { ST } from "../theme.ts";
import { displayWidth, truncateAnsi } from "../../util/ansi.ts";
import { SLASH_COMMANDS, completeSlash, slashTokenEnd } from "../../core/commands.ts";

/** Input prompt marker (also sizes the input window). */
export const PROMPT = "you › ";

/** Escape sequences the input claims (cursor + delete, wherever it sits in the chain). */
const INPUT_KEYS: Record<string, () => void> = {
  "\x1b[3~": del, // Delete
  "\x1b[1~": () => setCursor(0), // Home (rxvt)
  "\x1b[4~": () => setCursor(getState().input.length), // End (rxvt)
  "\x1b[H": () => setCursor(0), // Home
  "\x1b[F": () => setCursor(getState().input.length), // End
  "\x1bOH": () => setCursor(0),
  "\x1bOF": () => setCursor(getState().input.length),
  "\x1bOC": () => moveCursor(1), // Right (application mode)
  "\x1bOD": () => moveCursor(-1), // Left (application mode)
  "\x1b[C": () => moveCursor(1), // Right
  "\x1b[D": () => moveCursor(-1), // Left
};

/** The code point at `index`, as a string (never splits a surrogate pair). */
function codePointAt(text: string, index: number): string {
  const cp = text.codePointAt(index);
  return cp === undefined ? "" : String.fromCodePoint(cp);
}

/** The code point width in cells at `index` (2 for a wide rune, 0 for none). */
function codePointWidth(text: string, index: number): number {
  const cp = text.codePointAt(index);
  if (cp === undefined) return 0;
  return displayWidth(String.fromCodePoint(cp));
}

/** Insert text at the cursor (control characters stripped). */
export function insert(text: string): void {
// eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  if (clean === "") return;
  const state = getState();
  setState({
    input: state.input.slice(0, state.cursor) + clean + state.input.slice(state.cursor),
    cursor: state.cursor + clean.length,
    commandSel: 0,
  });
}

/** Delete the character before the cursor. */
export function backspace(): void {
  const state = getState();
  if (state.cursor === 0) return;
  setState({
    input: state.input.slice(0, state.cursor - 1) + state.input.slice(state.cursor),
    cursor: state.cursor - 1,
    commandSel: 0,
  });
}

/** Delete the character at the cursor. */
export function del(): void {
  const state = getState();
  if (state.cursor >= state.input.length) return;
  setState({
    input: state.input.slice(0, state.cursor) + state.input.slice(state.cursor + 1),
    commandSel: 0,
  });
}

/** Move the cursor by `delta` (clamped into the buffer). */
export function moveCursor(delta: number): void {
  const state = getState();
  setState({ cursor: Math.max(0, Math.min(state.input.length, state.cursor + delta)) });
}

/** Place the cursor at `pos` (clamped into the buffer). */
export function setCursor(pos: number): void {
  const state = getState();
  setState({ cursor: Math.max(0, Math.min(state.input.length, pos)) });
}

export class InputComponent extends BaseComponent {
  constructor() {
    super(true);
  }

  /** One styled input row: marker + text window with a highlighted cursor. */
  render(ctx: RenderContext): string {
    const inputLine = this.renderInputLine(ctx.cols);
    const menu = this.renderMenu(ctx.cols);
    return menu === "" ? inputLine : `${inputLine}\n${menu}`;
  }

  /** The prompt + text window row (single line). */
  private renderInputLine(cols: number): string {
    const state = getState();
    const markerW = displayWidth(PROMPT);
    const avail = Math.max(1, cols - markerW);
    const text = state.input;
    const pos = Math.max(0, Math.min(state.cursor, text.length));

    // Keep the cursor inside the visible window; the window lives in the
    // store and is persisted back only when it actually changes.
    // The window start advances by whole code points so a wide rune is
    // never split across the window edge.
    let scroll = Math.max(0, Math.min(state.inputScroll, Math.max(0, text.length)));
    if (pos < scroll) scroll = pos;
    while (scroll < pos && displayWidth(text.slice(scroll, pos)) > avail - 1) {
      const next = scroll + codePointWidth(text, scroll);
      scroll = next === scroll ? scroll + 1 : next;
    }
    if (scroll !== state.inputScroll) setState({ inputScroll: scroll });

    const win = text.slice(scroll);
    const before = win.slice(0, pos - scroll);
    // The cursor covers the whole code point under it — a wide rune is
    // highlighted as one unit, and its cell width is what the text after
    // it is capped by.
    const at = codePointAt(win, pos - scroll);
    const after = win.slice(pos - scroll + at.length);
    const atWidth = at === "" ? 1 : codePointWidth(win, pos - scroll);
    const widthAfter = Math.max(0, avail - displayWidth(before) - atWidth);

    const parts: string[] = [
      ST.promptMarker.render(PROMPT),
      ST.inputText.render(before),
      at === "" ? ST.cursor.render(" ") : ST.cursor.render(at),
      ST.inputText.render(truncateAnsi(after, widthAfter)),
    ];
    return truncateAnsi(joinHorizontal(Left, ...parts), cols);
  }

  /**
   * Slash-command autocomplete row: shown only when the input line starts
   * with "/" (the trigger) and at least one command matches. The selected
   * candidate is highlighted; Tab cycles through and applies the selection.
   */
  private renderMenu(cols: number): string {
    const candidates = completeSlash(getState().input);
    if (candidates.length === 0) return "";
    const state = getState();
    const sel = Math.max(0, Math.min(state.commandSel, candidates.length - 1));
    const parts: string[] = [ST.promptMarker.render("↹ ")];
    candidates.forEach((candidate, index) => {
      parts.push(
        index === sel ? ST.suggestionSel.render(candidate) : ST.suggestion.render(candidate),
      );
    });
    const selected = candidates[sel];
    const command = SLASH_COMMANDS.find((c) => "/" + c.name === selected);
    if (command !== undefined) parts.push(ST.suggestion.render(`— ${command.summary}`));
    return truncateAnsi(joinHorizontal(Left, ...parts), cols);
  }

  override handleChar(ch: string): "handled" | "unhandled" {
    if (ch === "\r" || ch === "\n") return "unhandled"; // submit → globals
    if (ch === "\t") return this.completeTab() ? "handled" : "unhandled";
    if (ch === "\x1b") return "unhandled"; // Esc → viewport or globals
    if (ch === "\x03") return "unhandled"; // Ctrl+C is intentionally unbound
    if (ch === "\x7f" || ch === "\x08") {
      backspace();
      return "handled";
    }
    if (ch < " ") return "handled"; // other control chars stay swallowed
    insert(ch);
    return "handled";
  }

  /**
   * Tab inside a slash line: advance the completion selection and apply it
   * (replaces the typed token; anything after a space is preserved). Returns
   * false when autocomplete is not active so Tab still bubbles to the global
   * focus-cycling binding.
   */
  private completeTab(): boolean {
    const state = getState();
    const candidates = completeSlash(state.input);
    if (candidates.length === 0) return false;
    const next = (state.commandSel + 1) % candidates.length;
    const candidate = candidates[next];
    if (candidate === undefined) return false;
    const end = slashTokenEnd(state.input);
    setState({
      input: candidate + state.input.slice(end),
      cursor: candidate.length,
      commandSel: next,
    });
    return true;
  }

  override handleKey(seq: string): "handled" | "unhandled" {
    const run = INPUT_KEYS[seq];
    if (run === undefined) return "unhandled";
    run();
    return "handled";
  }
}
