/**
 * Input bar: prompt marker + text window with a highlighted cursor, plus all
 * input-editing key handling (chars, cursor moves, delete). Reads the input
 * buffer / cursor / window scroll from the store and signals edits back via
 * `setState` — the store stays the single source of truth.
 *
 * Key handling is scoped by focus: the router offers keys to the focused
 * component first, then the remaining components, then the global bindings.
 * The input claims every editing key whenever it is reached (focused or
 * not); submit / Tab / Ctrl+C / Esc bubble up so the globals and the
 * viewport can claim them first.
 */
import { joinHorizontal, Left } from "@oakoliver/lipgloss";
import { BaseComponent, type RenderContext } from "./Component.ts";
import { getState, setState } from "../../core/store.ts";
import { ST } from "../theme.ts";
import { displayWidth, truncateAnsi } from "../../util/ansi.ts";

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

/** Insert text at the cursor (control characters stripped). */
export function insert(text: string): void {
  const clean = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  if (clean === "") return;
  const state = getState();
  setState({
    input: state.input.slice(0, state.cursor) + clean + state.input.slice(state.cursor),
    cursor: state.cursor + clean.length,
  });
}

/** Delete the character before the cursor. */
export function backspace(): void {
  const state = getState();
  if (state.cursor === 0) return;
  setState({
    input: state.input.slice(0, state.cursor - 1) + state.input.slice(state.cursor),
    cursor: state.cursor - 1,
  });
}

/** Delete the character at the cursor. */
export function del(): void {
  const state = getState();
  if (state.cursor >= state.input.length) return;
  setState({
    input: state.input.slice(0, state.cursor) + state.input.slice(state.cursor + 1),
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
    const state = getState();
    const markerW = displayWidth(PROMPT);
    const avail = Math.max(1, ctx.cols - markerW);
    const text = state.input;
    const pos = Math.max(0, Math.min(state.cursor, text.length));

    // Keep the cursor inside the visible window; the window lives in the
    // store and is persisted back only when it actually changes.
    let scroll = Math.max(0, Math.min(state.inputScroll, Math.max(0, text.length)));
    if (pos < scroll) scroll = pos;
    while (scroll < pos && displayWidth(text.slice(scroll, pos)) > avail - 1) scroll += 1;
    if (scroll !== state.inputScroll) setState({ inputScroll: scroll });

    const win = text.slice(scroll);
    const before = win.slice(0, pos - scroll);
    const at = win.slice(pos - scroll, pos - scroll + 1);
    const after = win.slice(pos - scroll + 1);
    const widthAfter = Math.max(0, avail - displayWidth(before) - 1);

    const parts: string[] = [
      ST.promptMarker.render(PROMPT),
      ST.inputText.render(before),
      at === "" ? ST.cursor.render(" ") : ST.cursor.render(at),
      ST.inputText.render(truncateAnsi(after, widthAfter)),
    ];
    const line = joinHorizontal(Left, ...parts);
    return truncateAnsi(line, ctx.cols);
  }

  /** Rows this component occupies: always a single line. */
  measure(_width: number): number {
    return 1;
  }

  override handleChar(ch: string): "handled" | "unhandled" {
    if (ch === "\r" || ch === "\n") return "unhandled"; // submit → globals
    if (ch === "\x03" || ch === "\t" || ch === "\x1b") {
      return "unhandled"; // quit / focus cycle / Esc → viewport or globals
    }
    if (ch === "\x7f" || ch === "\x08") {
      backspace();
      return "handled";
    }
    if (ch < " ") return "handled"; // other control chars stay swallowed
    insert(ch);
    return "handled";
  }

  override handleKey(seq: string): "handled" | "unhandled" {
    const run = INPUT_KEYS[seq];
    if (run === undefined) return "unhandled";
    run();
    return "handled";
  }
}
