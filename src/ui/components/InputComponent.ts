/**
 * Input bar: a bubbletea `TextArea` model drives the whole editing surface —
 * typing, cursor movement, deletion, soft wrapping, and the virtual cursor.
 * The model is component-owned state (the widget keeps its own value/cursor/
 * scroll); the central store stays in sync for the **input text only** (it is
 * what submit and slash autocomplete read), and nothing else mirrors the
 * widget's internals. Each edit writes `input` (and resets the slash-command
 * completion selection) back via `setState`, so the render scheduler fires
 * through the normal store path.
 *
 * Geometry: the textarea grows and shrinks to fit its content, from one row
 * up to `MAX_LINES` rows; when content exceeds that, the widget scrolls
 * vertically (its internal viewport) — the input row count the pipeline sees
 * is capped at `MAX_LINES`.
 *
 * Submit boundary: plain Enter (CR/LF) is **not** claimed here — it bubbles
 * to the router's global submit binding. Shift+Enter is claimed and maps to
 * the textarea's `insertNewline`, so it inserts a line break without
 * submitting. Bracketed paste is decoded by the composition root (main.ts)
 * and delivered as one `paste(content)` call, so pasted newlines are inserted
 * literally and never trigger submit.
 *
 * Key routing stays as before: the router offers the key to the focused
 * component first, then the rest of the chain, then globals. The input
 * claims every editing key whenever it is reached (focused or not); submit
 * and Esc bubble, and Tab completes a slash command or bubbles to the
 * focus-cycling global. Up/Down are claimed only while the input spans
 * multiple lines — a single-line input leaves them for the log-scroll
 * globals. Ctrl+C is intentionally unbound (inert).
 */
import { KeyCode, KeyMod, KeyPressMsg } from "@oakoliver/bubbletea";
import {
  newBinding,
  newTextarea,
  textareaDefaultDarkStyles,
  withHelp,
  withKeys,
} from "@oakoliver/bubbles";
import type { TextareaModel, TextareaStyles } from "@oakoliver/bubbles";
import { joinHorizontal, Left, newStyle } from "@oakoliver/lipgloss";
import { BaseComponent, type KeyResult, type RenderContext } from "./Component.ts";
import { getState, setState } from "../../core/store.ts";
import { ST, CURSOR_COLOR } from "../theme.ts";
import { displayWidth, truncateAnsi } from "../../util/ansi.ts";
import { SLASH_COMMANDS, completeSlash, slashTokenEnd } from "../../core/commands.ts";

/** Input prompt marker (also sizes the textarea's prompt gutter). */
export const PROMPT = "you › ";

/** The input grows to this many rows before it scrolls vertically. */
export const MAX_LINES = 10;

/**
 * Shift+Enter sequences across modifier-reporting schemes:
 * - `ESC[13;2u` — CSI-u / Kitty keyboard protocol (Ghostty, kitty, WezTerm, …)
 * - `ESC[27;2;13~` — xterm-style modifyOtherKeys
 * - `ESC[13;2~` — lenient fallback for terminals that final with `~`
 */
const SHIFT_ENTER_SEQS: ReadonlySet<string> = new Set([
  "\x1b[13;2u",
  "\x1b[27;2;13~",
  "\x1b[13;2~",
]);

/** A key event fed to the textarea model (shape of bubbletea's `Key`). */
interface SeqKey {
  readonly text?: string;
  readonly mod?: number;
  readonly code: number;
}

/** Escape sequences the input claims (editing keys, generally cursor moves). */
const SEQ_KEYS: Readonly<Record<string, SeqKey>> = {
  "\x1b[A": { code: KeyCode.Up },
  "\x1b[B": { code: KeyCode.Down },
  "\x1b[C": { code: KeyCode.Right },
  "\x1b[D": { code: KeyCode.Left },
  "\x1b[H": { code: KeyCode.Home },
  "\x1b[F": { code: KeyCode.End },
  "\x1bOA": { code: KeyCode.Up }, // application mode
  "\x1bOB": { code: KeyCode.Down },
  "\x1bOC": { code: KeyCode.Right },
  "\x1bOD": { code: KeyCode.Left },
  "\x1bOH": { code: KeyCode.Home },
  "\x1bOF": { code: KeyCode.End },
  "\x1b[1~": { code: KeyCode.Home }, // rxvt
  "\x1b[4~": { code: KeyCode.End }, // rxvt
  "\x1b[3~": { code: KeyCode.Delete },
};

/** Textarea styles mapped onto the theme (cursor block, prompt marker). */
function inputStyles(): TextareaStyles {
  const styles = textareaDefaultDarkStyles();
  styles.focused.cursorLine = newStyle();
  styles.focused.text = newStyle();
  styles.focused.prompt = ST.promptMarker;
  styles.blurred.cursorLine = newStyle();
  styles.blurred.text = newStyle();
  styles.blurred.prompt = ST.promptMarker;
  styles.cursor.color = CURSOR_COLOR;
  styles.cursor.blink = false; // static block cursor — no blink command loop
  return styles;
}

export class InputComponent extends BaseComponent {
  private readonly textarea: TextareaModel;
  private lastCols = 0;

  constructor() {
    super(true);
    const ta = newTextarea();
    ta.prompt = PROMPT;
    ta.showLineNumbers = false;
    ta.dynamicHeight = true;
    ta.minHeight = 1;
    ta.maxHeight = MAX_LINES;
    ta.keyMap.insertNewline = newBinding(
      withKeys("shift+enter"),
      withHelp("Shift+Enter", "insert newline"),
    );
    ta.setStyles(inputStyles());
    // Prompt on the first visual row only; continuation rows keep the same
    // left gutter so text stays aligned.
    ta.setPromptFunc(displayWidth(PROMPT), ({ lineNumber }) => (lineNumber === 0 ? PROMPT : ""));
    ta.focus();
    this.textarea = ta;
  }

  /** Feed one key event to the textarea model (moves value/cursor/scroll). */
  private feed(key: SeqKey): void {
    this.textarea.update(
      new KeyPressMsg({ text: key.text ?? "", mod: key.mod ?? KeyMod.None, code: key.code }),
    );
  }

  /** Mirror the textarea value into the store (no completion reset). */
  private syncInput(): void {
    setState({ input: this.textarea.value() });
  }

  /** Mirror an edit into the store and reset the completion selection. */
  private commitEdit(): void {
    setState({ input: this.textarea.value(), commandSel: 0 });
  }

  /** Apply the current terminal width to the textarea (soft-wrap/dynamic height). */
  private layout(cols: number): void {
    if (cols === this.lastCols) return;
    this.lastCols = cols;
    this.textarea.setWidth(Math.max(1, cols));
  }

  /** One styled input block: textarea rows + optional slash-command menu row. */
  render(ctx: RenderContext): string {
    this.layout(ctx.cols);
    const inputView = this.textarea.view();
    const menu = this.renderMenu(ctx.cols);
    return menu === "" ? inputView : `${inputView}\n${menu}`;
  }

  /**
   * Slash-command autocomplete row: shown only when the input starts with
   * "/" (the trigger) and at least one command matches. The selected
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

  /** Insert pasted text verbatim (newlines included) — never submits. */
  paste(content: string): void {
    const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (normalized === "") return;
    this.textarea.update({ type: "textarea.paste", content: normalized });
    this.commitEdit();
  }

  /** Clear the input (used after submit / slash commands). */
  reset(): void {
    this.textarea.reset();
    setState({ input: "", commandSel: 0 });
  }

  override handleChar(ch: string): KeyResult {
    if (ch === "\r" || ch === "\n") return "unhandled"; // submit → globals
    if (ch === "\t") return this.completeTab() ? "handled" : "unhandled";
    if (ch === "\x1b") return "unhandled"; // Esc → viewport or globals
    if (ch === "\x03") return "unhandled"; // Ctrl+C is intentionally unbound
    if (ch === "\x7f" || ch === "\x08") {
      this.feed({ code: KeyCode.Backspace });
      this.commitEdit();
      return "handled";
    }
    if (ch < " ") return "handled"; // other control chars stay swallowed
    this.textarea.update(
      new KeyPressMsg({
        text: ch,
        mod: KeyMod.None,
        code: ch.codePointAt(0) ?? 0,
      }),
    );
    this.commitEdit();
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
    const replaced = candidate + state.input.slice(end);
    this.textarea.setValue(replaced);
    this.textarea.setCursorColumn(candidate.length);
    setState({ input: replaced, commandSel: next });
    return true;
  }

  override handleKey(seq: string): KeyResult {
    if (SHIFT_ENTER_SEQS.has(seq)) {
      this.feed({ code: KeyCode.Enter, mod: KeyMod.Shift });
      this.commitEdit();
      return "handled";
    }
    const key = SEQ_KEYS[seq];
    if (key === undefined) return "unhandled";
    // Up/Down move the caret only when the input spans multiple lines; a
    // single-line input leaves them to the log-scroll globals.
    if (
      (key.code === KeyCode.Up || key.code === KeyCode.Down) &&
      !this.textarea.value().includes("\n")
    ) {
      return "unhandled";
    }
    this.feed(key);
    this.syncInput(); // navigation only — keep the completion selection
    return "handled";
  }
}
