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
 * Geometry: the textarea's visible viewport stays between one row and
 * `MAX_LINES` rows — beyond that the widget scrolls internally and keeps the
 * cursor row in view. The *content* is bounded separately by
 * `MAX_CONTENT_ROWS` (visual rows, a generous ceiling so single-line soft
 * wraps and multi-line pastes both fit) and `MAX_INPUT_CHARS` characters.
 *
 * Key routing: the input is the "input" target of the top-level focus ring
 * (see `keyRouter`). While it holds the ring, it receives ALL keys: escape
 * sequences are translated into `KeyPressMsg` events (the textarea's default
 * keymap — arrows, word navigation, Home/End, PgUp/PgDn, Ctrl+A/E/K/U/W,
 * selection, copy, case transforms, …) and fed to the model. The few
 * app-level carve-outs are:
 * - Enter (CR/LF) is **not** claimed — it bubbles to the global submit.
 * - Shift+Enter maps to the textarea's `insertNewline` (newline, no submit).
 * - Shift+Up moves the top-level ring to the log.
 * - Esc bubbles (abort turn); Tab completes a slash command.
 * Bracketed paste is decoded by the composition root (main.ts) and delivered
 * as one `paste(content)` call, so pasted newlines are inserted literally and
 * never trigger submit.
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
import { newStyle } from "@oakoliver/lipgloss";
import { BaseComponent, type KeyResult, type RenderContext } from "./Component.ts";
import { getState, setState } from "../../core/store.ts";
import { displayWidth, truncateAnsi, wrapText } from "../../util/ansi.ts";
import { ST, CURSOR_COLOR, CURSOR_COLOR_BLUR } from "../theme.ts";
import {
  SLASH_COMMANDS,
  completeSlash,
  resolveSlash,
  registryVersion,
  slashTokenEnd,
  type SlashCommand,
} from "../../core/commands.ts";
import { getTopLevel, setTopLevel } from "./keyRouter.ts";

/**
 * Slash-command lookup by "/name", version-stamped on the command
 * registry: server descriptors land after module init (capabilities probe),
 * so a once-built map would go stale. Rebuilt only when the registry
 * version changes — the render hot path reads it per frame.
 */
let slashByNameCache: { version: number; value: Map<string, SlashCommand> } | null = null;

function slashByName(): Map<string, SlashCommand> {
  if (slashByNameCache === null || slashByNameCache.version !== registryVersion) {
    slashByNameCache = {
      version: registryVersion,
      value: new Map(SLASH_COMMANDS.map((command) => ["/" + command.name, command])),
    };
  }
  return slashByNameCache.value;
}

/** Rows the input's visible viewport grows to before it scrolls internally. */
export const MAX_LINES = 10;

/** Hard cap on the input's character content (the textarea truncates beyond it). */
export const MAX_INPUT_CHARS = 5000;

/**
 * Hard cap on the input's *content* rows (visual rows, soft-wrapped). The
 * visible viewport is `MAX_LINES`; this is how much text the buffer itself
 * may hold past that. Without it the textarea's legacy guard would stop
 * inserts at `MAX_LINES` logical lines. It can never bind before
 * `MAX_INPUT_CHARS` does — every visual row costs at least one character —
 * so it is simply derived from the character cap.
 */
export const MAX_CONTENT_ROWS = MAX_INPUT_CHARS;

/** Maximum rows the slash autocomplete menu shows (candidates in ranked order). */
export const MAX_MENU_ROWS = 5;

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

/** Shift+Up encodings — move top-level focus from the input to the log. */
const SHIFT_UP_SEQS: ReadonlySet<string> = new Set([
  "\x1b[1;2A", // xterm-style
  "\x1b[65;2u", // CSI-u / Kitty
]);

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

/** Modifier bits for a CSI parameter byte (1=shift, 2=alt, 4=ctrl…). */
function modFor(param: number): number {
  switch (param) {
    case 1:
      return KeyMod.Shift;
    case 2:
      return KeyMod.Shift;
    case 3:
      return KeyMod.Alt;
    case 4:
      return KeyMod.Alt | KeyMod.Shift;
    case 5:
      return KeyMod.Ctrl;
    case 6:
      return KeyMod.Ctrl | KeyMod.Shift;
    case 7:
      return KeyMod.Ctrl | KeyMod.Alt;
    case 8:
      return KeyMod.Ctrl | KeyMod.Alt | KeyMod.Shift;
    default:
      return KeyMod.None;
  }
}

/** Key code for a CSI-u (Kitty) code point. */
function codeForU(cp: number): number | undefined {
  switch (cp) {
    case 13:
      return KeyCode.Enter;
    case 127:
    case 8:
      return KeyCode.Backspace;
    case 9:
      return KeyCode.Tab;
    case 27:
      return KeyCode.Escape;
    case 32:
      return KeyCode.Space;
    case 65:
      return KeyCode.Up;
    case 66:
      return KeyCode.Down;
    case 67:
      return KeyCode.Right;
    case 68:
      return KeyCode.Left;
    case 70:
      return KeyCode.End;
    case 72:
      return KeyCode.Home;
    default:
      return undefined;
  }
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
  const paramStr = match[1] as string;
  const final = match[2] as string;
  const params = paramStr === "" ? [] : paramStr.split(";").map(Number);
  const mod = params.length >= 2 ? modFor(params[1] ?? 0) : KeyMod.None;

  let code: number | undefined;
  switch (final) {
    case "A":
      code = KeyCode.Up;
      break;
    case "B":
      code = KeyCode.Down;
      break;
    case "C":
      code = KeyCode.Right;
      break;
    case "D":
      code = KeyCode.Left;
      break;
    case "H":
      code = KeyCode.Home;
      break;
    case "F":
      code = KeyCode.End;
      break;
    case "u": {
      const cp = params[0];
      if (cp === undefined) return undefined;
      code = codeForU(cp);
      break;
    }
    case "~": {
      const kind = params[0];
      if (kind === 1) code = KeyCode.Home;
      else if (kind === 4) code = KeyCode.End;
      else if (kind === 3) code = KeyCode.Delete;
      else if (kind === 5) code = KeyCode.PgUp;
      else if (kind === 6) code = KeyCode.PgDown;
      break;
    }
    default:
      return undefined;
  }
  if (code === undefined) return undefined;
  return { code, mod };
}

/** Textarea styles mapped onto the theme (black backing, purple left border).
 *  When `blurred` is true the text renders dark grey and the cursor uses the
 *  darker purple — the visual cue that the log holds the top-level focus ring.
 *  The base style paints the whole widget black and adds a 1-cell horizontal
 *  padding inside a purple right-half-block left border (same purple as the
 *  input's prompt marker, mirroring the assistant prose gutter). */
function inputStyles(blurred: boolean): TextareaStyles {
  const styles = textareaDefaultDarkStyles();
  const text = blurred ? ST.inputTextBlur : ST.inputText;
  const lineStyle = blurred ? ST.inputTextBlur : newStyle();
  styles.focused.base = ST.inputBase;
  styles.blurred.base = ST.inputBase;
  styles.focused.cursorLine = lineStyle;
  styles.focused.text = text;
  styles.focused.prompt = ST.promptMarker;
  styles.blurred.cursorLine = lineStyle;
  styles.blurred.text = text;
  styles.blurred.prompt = ST.promptMarker;
  styles.cursor.color = blurred ? CURSOR_COLOR_BLUR : CURSOR_COLOR;
  styles.cursor.blink = false; // static block cursor — no blink command loop
  return styles;
}

export class InputComponent extends BaseComponent {
  private readonly textarea: TextareaModel;
  private lastCols = 0;
  /**
   * Monotonic edit counter: bumped by every method that can mutate the
   * textarea (key/char/paste/reset/completion). The frame cache and the
   * store sync both key on it, so unchanged buffers never re-join /
   * re-render. Navigation also bumps it (cursor/scroll change the view).
   */
  private version = 0;
  /** Last frame produced by `render`, with the key it was produced under. */
  private frameCache: { key: string; value: string } | null = null;
  /** Last menu string, keyed by (input, commandSel, cols). */
  private menuCache: { key: string; value: string } | null = null;
  /** Last value synced into the store, to skip redundant joins/writes. */
  private lastSyncedValue = "";
  /** Style sets for the two ring states (focused vs blurred). */
  private readonly stylesFocused: TextareaStyles;
  private readonly stylesBlurred: TextareaStyles;
  private activeStyles: TextareaStyles;

  constructor() {
    super(true);
    const ta = newTextarea();
    ta.prompt = "";
    ta.showLineNumbers = false;
    ta.dynamicHeight = true;
    ta.minHeight = 1;
    ta.maxHeight = MAX_LINES;
    ta.maxContentHeight = MAX_CONTENT_ROWS;
    ta.charLimit = MAX_INPUT_CHARS;
    ta.keyMap.insertNewline = newBinding(
      withKeys("shift+enter"),
      withHelp("Shift+Enter", "insert newline"),
    );
    const stylesFocused = inputStyles(false);
    const stylesBlurred = inputStyles(true);
    this.stylesFocused = stylesFocused;
    this.stylesBlurred = stylesBlurred;
    this.activeStyles = stylesFocused;
    ta.setStyles(stylesFocused);
    ta.focus();
    this.textarea = ta;
  }

  /** Swap the textarea styles to match the current ring target. */
  private syncFocusStyle(): void {
    const target = getTopLevel() === "input" ? this.stylesFocused : this.stylesBlurred;
    if (this.activeStyles === target) return;
    this.activeStyles = target;
    this.textarea.setStyles(target);
  }

  /** Feed one key event to the textarea model (moves value/cursor/scroll). */
  private feed(key: SeqKey): void {
    this.textarea.update(
      new KeyPressMsg({ text: key.text ?? "", mod: key.mod ?? KeyMod.None, code: key.code }),
    );
    this.version += 1;
  }

  /**
   * Mirror the textarea value into the store (no completion reset).
   * Returns whether the value changed (and was therefore synced, which
   * already pokes the render scheduler via `setState`).
   * The whole-buffer `value()` join runs only when the value actually
   * changed since the last sync — navigation reuses the settled string.
   */
  private syncInput(): boolean {
    const value = this.currentValue();
    if (value === this.lastSyncedValue) return false;
    this.lastSyncedValue = value;
    setState({ input: value });
    return true;
  }

  /** Mirror an edit into the store and reset the completion selection. */
  private commitEdit(): void {
    const value = this.currentValue();
    this.lastSyncedValue = value;
    setState({ input: value, commandSel: 0 });
  }

  /**
   * Current textarea value, memoized on `version`. `value()` joins the
   * whole buffer, so callers that only need to know *whether* it changed
   * (sync paths, the Up/Down gate) should go through `version` first.
   */
  private cachedValue: { version: number; value: string } | null = null;
  private currentValue(): string {
    if (this.cachedValue !== null && this.cachedValue.version === this.version) {
      return this.cachedValue.value;
    }
    const value = this.textarea.value();
    this.cachedValue = { version: this.version, value };
    return value;
  }

  /** Apply the current terminal width to the textarea (soft-wrap/dynamic height). */
  private layout(cols: number): void {
    if (cols === this.lastCols) return;
    this.lastCols = cols;
    this.textarea.setWidth(Math.max(1, cols));
  }

  /**
   * Frame cache key: everything that can change the rendered rows.
   * `view()` re-wraps/re-styles the whole buffer, so `measure()` (layout
   * stage) and `render()` (paint stage) in the same frame share one
   * production instead of each running a full render.
   */
  private frameKey(cols: number): string {
    // Grounded in the store-synced string by reference + length, not by
    // value: joining the whole input into the key would be O(buffer) per
    // render — the exact cost this cache exists to avoid. Every path that
    // changes the textarea bumps `version`, and the store input is only
    // ever written from here, so (version, synced length) is exact.
    const synced = this.lastSyncedValue;
    return [
      this.version,
      cols,
      this.activeStyles === this.stylesFocused ? "f" : "b",
      this.textarea.line(),
      this.textarea.column(),
      this.textarea.scrollYOffset(),
      synced.length,
      getState().commandSel,
    ].join(":");
  }

  /** One styled input block: textarea rows + optional slash-command menu row. */
  render(ctx: RenderContext): string {
    this.syncFocusStyle();
    this.layout(ctx.cols);
    const key = this.frameKey(ctx.cols);
    if (this.frameCache !== null && this.frameCache.key === key) {
      return this.frameCache.value;
    }
    const inputView = this.textarea.view();
    const menu = this.renderMenu(ctx.cols);
    const value = menu === "" ? inputView : `${inputView}\n${menu}`;
    this.frameCache = { key, value };
    return value;
  }

  /**
   * Row count without a second full render: reuses the frame cache, so the
   * layout stage never triggers a redundant `textarea.view()`.
   */
  override measure(width: number): number {
    const cols = Math.max(0, Math.floor(width));
    const rendered = this.render({ cols });
    return rendered === "" ? 0 : rendered.split("\n").length;
  }
  /** Total characters currently in the input. */
  textLength(): number {
    return this.textarea.length();
  }

  /**
   * Slash-command autocomplete list: shown only when the input starts with
   * "/" (the trigger) and at least one command matches. The selected
   * candidate is highlighted; Tab cycles through and applies the selection.
   */
  private renderMenu(cols: number): string {
    const state = getState();
    // Key on length + prefix only: the menu depends on the slash token at
    // the head of the input, and joining a 5000-char buffer into the key
    // per frame would reintroduce the O(buffer) cost this cache avoids.
    const input = state.input;
    const menuKey = `${input.length}:${input.slice(0, 64)}:${state.commandSel}:${cols}`;
    if (this.menuCache !== null && this.menuCache.key === menuKey) {
      return this.menuCache.value;
    }
    const value = this.renderMenuUncached(state.input, state.commandSel, cols);
    this.menuCache = { key: menuKey, value };
    return value;
  }

  private renderMenuUncached(input: string, commandSel: number, cols: number): string {
    const state = { input, commandSel };
    const resolved = resolveSlash(state.input);
    // Once the command token resolves — typed exactly or with args — show the
    // args view instead of the fuzzy list. The list only returns when the
    // input no longer matches up (partial/unknown token).
    if (resolved !== undefined) {
      return this.renderExactMenu(resolved, cols);
    }
    const candidates = completeSlash(state.input);
    if (candidates.length === 0) return "";
    const sel = Math.max(0, Math.min(state.commandSel, candidates.length - 1));
    const shown = candidates.slice(0, MAX_MENU_ROWS);
    const byName = slashByName();
    const labels = shown.map((candidate) =>
      candidate.startsWith("/") ? candidate.slice(1) : candidate,
    );
    const labelW = Math.max(...labels.map((label) => displayWidth(label)));
    const body: string[] = [];
    for (let index = 0; index < labels.length; index++) {
      const command = byName.get(candidates[index] as string);
      const label = labels[index] as string;
      const lead = index === 0 ? "↹ " : "  ";
      const labelPadded = label + " ".repeat(labelW - displayWidth(label) + 2);
      const head = lead + labelPadded;
      const room = Math.max(0, cols - displayWidth(head));
      let desc = command?.summary ?? "";
      if (displayWidth(desc) > room) {
        desc = room >= 2 ? truncateAnsi(desc, room - 1) + "…" : "";
      }
      const style = index === sel ? ST.suggestionSel : ST.suggestion;
      body.push(style.width(cols).render(head + desc));
    }
    return body.join("\n");
  }

  /** Single-command view: highlighted header + dim flush-left description. */
  private renderExactMenu(command: SlashCommand, cols: number): string {
    const head = command.name + " ";
    const body: string[] = [ST.suggestionSel.width(cols).render(head + (command.args ?? ""))];
    for (const wline of wrapText(command.summary, cols)) {
      body.push(ST.suggestion.render(wline));
    }
    return body.join("\n");
  }
  /** Insert pasted text verbatim (newlines included) — never submits. */
  paste(content: string): void {
    const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (normalized === "") return;
    this.textarea.update({ type: "textarea.paste", content: normalized });
    this.version += 1;
    this.commitEdit();
  }

  /** Clear the input (used after submit / slash commands). */
  reset(): void {
    this.textarea.reset();
    this.version += 1;
    this.lastSyncedValue = "";
    setState({ input: "", commandSel: 0 });
  }

  /** Feed a control character (Ctrl+letter) to the textarea model. */
  private feedControl(code: number): void {
    this.textarea.update(new KeyPressMsg({ text: "", mod: KeyMod.Ctrl, code }));
    this.version += 1;
    this.commitEdit();
  }

  override handleChar(ch: string): KeyResult {
    if (ch === "\r" || ch === "\n") return "unhandled"; // submit → globals
    if (ch === "\t") {
      // The args view has nothing to complete — Tab is a no-op there.
      if (resolveSlash(getState().input) !== undefined) return "handled";
      return this.completeTab() ? "handled" : "unhandled";
    }
    if (ch === "\x1b") return "unhandled"; // Esc → viewport or globals
    if (ch === "\x03") return "unhandled"; // Ctrl+C is intentionally unbound
    if (ch === "\x7f") {
      this.feed({ code: KeyCode.Backspace });
      this.commitEdit();
      return "handled";
    }
    const code = ch.charCodeAt(0);
    // The textarea binds every Ctrl+letter editing key (ctrl+a/e/k/u/w/f/b/
    // n/p/t/g/h/d…); route them all to the model. Unknown control chars are
    // still swallowed so they never leak into the text.
    if (code >= 1 && code <= 26) {
      this.feedControl(code);
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
    this.version += 1;
    this.commitEdit();
    return "handled";
  }

  /**
   * Tab inside a slash line: apply the highlighted completion (the first
   * ranked match by default) — Tab accepts the selection, it does not cycle.
   * Anything after the token is preserved. Returns false when autocomplete is
   * not active so Tab stays with the input ring (dropped) instead of leaking
   * into the log.
   */
  private completeTab(): boolean {
    const state = getState();
    const candidates = completeSlash(state.input);
    if (candidates.length === 0) return false;
    const sel = Math.max(0, Math.min(state.commandSel, candidates.length - 1));
    const candidate = candidates[sel];
    if (candidate === undefined) return false;
    const end = slashTokenEnd(state.input);
    const replaced = candidate + state.input.slice(end);
    this.textarea.setValue(replaced);
    this.textarea.setCursorColumn(candidate.length);
    this.version += 1;
    this.lastSyncedValue = replaced;
    setState({ input: replaced, commandSel: sel });
    return true;
  }
  override handleKey(seq: string): KeyResult {
    if (SHIFT_ENTER_SEQS.has(seq)) {
      this.feed({ code: KeyCode.Enter, mod: KeyMod.Shift });
      this.commitEdit();
      return "handled";
    }
    if (SHIFT_UP_SEQS.has(seq)) {
      setTopLevel("log");
      setState({}); // notify the scheduler so the blur style repaints
      return "handled";
    }
    const key = parseSeqKey(seq) ?? LEGACY_SEQ_KEYS[seq];
    if (key === undefined) return "unhandled";
    // Up/Down move the caret only when the input spans multiple lines; a
    // single-line input leaves them to the log-scroll globals.
    if ((key.code === KeyCode.Up || key.code === KeyCode.Down) && this.textarea.lineCount() <= 1) {
      return "unhandled";
    }
    this.feed(key);
    // Navigation only — keep the completion selection. A pure cursor /
    // scroll / selection move leaves the value unchanged, so `syncInput`
    // writes nothing — but the view *did* change. The render scheduler
    // only flushes on a store notification, so an unchanged value must
    // still poke it (`setState({})`, as the Shift+Up path above does);
    // without the poke no frame is ever drawn and the cursor appears
    // frozen even though the model moved. When the value did change
    // (Delete, case transforms, …) `syncInput` already notified.
    if (!this.syncInput()) setState({});
    return "handled";
  }
}
