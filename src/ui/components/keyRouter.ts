/**
 * Focus-scoped key routing with a top-level focus ring: the chat log and
 * the text input are the two ring targets, and the ring decides which
 * component receives keys at all.
 *
 * - While the input is the ring target, the input receives ALL keys:
 *   editing keys are translated to the textarea model, and the few
 *   app-level keys (Enter submit, Esc abort, Shift+Up → log) are carved out.
 * - While the log is the ring target, the log receives the keys (Tab /
 *   Shift-Tab cycle its focusable units; Home/End/PageUp/PageDown/arrows
 *   operate the viewport; Shift+Down or Esc-on-empty returns to the input).
 *   Unhandled keys are dropped — they are never passed to the input.
 *   Global bindings are scoped to a ring side: log-side navigation (Tab /
 *   Shift-Tab, Home/End/PageUp/PageDown/arrows) is consulted only while the
 *   log holds the ring, and input-side actions (Enter, Esc) only while the
 *   input does. Neither side's bindings can leak onto the other.
 *
 * Every component must declare its ring side via the `ring` property
 * ("log" or "input"); components without a ring never receive keys.
 *
 * Terminal geometry comes from the composition root through the `Globals`
 * surface — the router never reads `process.stdout` itself.
 */
import type { Component } from "./Component.ts";
import { Binding, matches, newBinding, withHelp, withKeys } from "@oakoliver/bubbles";

/** Top-level focus ring target. */
export type TopLevelTarget = "log" | "input";

/** Current top-level ring target (initial: the input, so typing just works). */
let topLevel: TopLevelTarget = "input";

/** Set the top-level ring target (focus the log or the input). */
export function setTopLevel(target: TopLevelTarget): void {
  topLevel = target;
}

/** The current top-level ring target. */
export function getTopLevel(): TopLevelTarget {
  return topLevel;
}

/** Global binding handlers supplied by the composition root. */
export interface Globals {
  /** /quit slash command: quit the application. */
  quit(): void;
  /** Tab: move the entry focus ring forward. */
  focusNext(): void;
  /** Shift+Tab: move the entry focus ring backward. */
  focusPrev(): void;
  /** Scroll the log by `delta` rows (positive = toward the bottom). */
  scrollBy(delta: number): void;
  /** Jump to the top (true) or bottom (false) of the log. */
  jump(top: boolean): void;
  /** Enter with no focused entry: submit the input. */
  submit(): void;
  /** Esc with no focused entry: abort the in-flight turn (no-op when idle). */
  abortTurn(): void;
  /** Terminal height in rows — the page size for PageUp/PageDown. */
  pageRows(): number;
}

/**
 * Global bindings for the LOG ring: only consulted while the log holds the
 * top-level ring, so none of them can ever reach the chat focus ring while
 * the text input is active. Entry-focus cycling and viewport navigation
 * live here.
 */
const LOG_KEY_BINDINGS: { binding: Binding; run: (g: Globals) => void }[] = [
  {
    binding: newBinding(withKeys("\x1b[Z"), withHelp("Shift+Tab", "previous entry")),
    run: (g) => g.focusPrev(),
  },
  {
    binding: newBinding(withKeys("\x1b[1;5H", "\x1b[72;5u"), withHelp("Ctrl+Home", "jump to top")),
    run: (g) => g.jump(true),
  },
  {
    binding: newBinding(
      withKeys("\x1b[1;5F", "\x1b[70;5u"),
      withHelp("Ctrl+End", "jump to bottom"),
    ),
    run: (g) => g.jump(false),
  },
  {
    binding: newBinding(withKeys("\x1b[H", "\x1b[1~", "\x1bOH"), withHelp("Home", "jump to top")),
    run: (g) => g.jump(true),
  },
  {
    binding: newBinding(withKeys("\x1b[F", "\x1b[4~", "\x1bOF"), withHelp("End", "jump to bottom")),
    run: (g) => g.jump(false),
  },
  {
    binding: newBinding(withKeys("\x1b[5~"), withHelp("PageUp", "scroll up one page")),
    run: (g) => g.scrollBy(-g.pageRows()),
  },
  {
    binding: newBinding(withKeys("\x1b[6~"), withHelp("PageDown", "scroll down one page")),
    run: (g) => g.scrollBy(g.pageRows()),
  },
  {
    binding: newBinding(withKeys("\x1bOA", "\x1b[A"), withHelp("Up", "scroll up one line")),
    run: (g) => g.scrollBy(-1),
  },
  {
    binding: newBinding(withKeys("\x1bOB", "\x1b[B"), withHelp("Down", "scroll down one line")),
    run: (g) => g.scrollBy(1),
  },
];

/**
 * Global bindings for the INPUT ring: only consulted while the input holds
 * the top-level ring. This is the deliberate, closed list of app-level keys
 * that still work while typing — currently just the single-line ↑/↓ scroll
 * carve-out (multi-line arrows are claimed by the textarea itself). Anything
 * added here is an explicit decision, never an accidental fall-through from
 * the log side.
 */
const INPUT_KEY_BINDINGS: { binding: Binding; run: (g: Globals) => void }[] = [
  {
    binding: newBinding(withKeys("\x1bOA", "\x1b[A"), withHelp("Up", "scroll up one line")),
    run: (g) => g.scrollBy(-1),
  },
  {
    binding: newBinding(withKeys("\x1bOB", "\x1b[B"), withHelp("Down", "scroll down one line")),
    run: (g) => g.scrollBy(1),
  },
];

/**
 * Char-level global bindings for the LOG ring: Tab cycles the log's entry
 * focus ring. Only consulted while the log holds the top-level ring.
 */
const LOG_CHAR_BINDINGS: { binding: Binding; run: (g: Globals) => void }[] = [
  {
    binding: newBinding(withKeys("\t"), withHelp("Tab", "next entry")),
    run: (g) => g.focusNext(),
  },
];

/**
 * Char-level global bindings for the INPUT ring: Enter submits, Esc aborts
 * the in-flight turn. Only consulted while the input holds the top-level ring.
 */
const INPUT_CHAR_BINDINGS: { binding: Binding; run: (g: Globals) => void }[] = [
  {
    binding: newBinding(withKeys("\r", "\n"), withHelp("Enter", "send input")),
    run: (g) => g.submit(),
  },
  {
    binding: newBinding(withKeys("\x1b"), withHelp("Esc", "abort turn")),
    run: (g) => g.abortTurn(),
  },
];

/**
 * The components that may receive keys for the current ring target: only
 * the side that holds the ring. The other side never sees a key.
 */
function ringWalk(chain: readonly Component[]): readonly Component[] {
  return chain.filter((c) => c.ring === topLevel);
}

/**
 * Route one key sequence: the ring target's components, then the active
 * ring side's global bindings. Returns whether anyone handled it
 * (false = dropped).
 */
export function routeKey(chain: readonly Component[], seq: string, globals: Globals): boolean {
  for (const component of ringWalk(chain)) {
    if (component.handleKey(seq) === "handled") return true;
  }
  const bindings = topLevel === "log" ? LOG_KEY_BINDINGS : INPUT_KEY_BINDINGS;
  for (const { binding, run } of bindings) {
    if (matches({ toString: () => seq }, binding)) {
      run(globals);
      return true;
    }
  }
  return false;
}

/**
 * Route one decoded character through the same ring ordering. Unclaimed chars
 * fall through to the active ring side's global bindings (log: Tab; input:
 * Enter/Esc).
 */
export function routeChar(chain: readonly Component[], ch: string, globals: Globals): boolean {
  for (const component of ringWalk(chain)) {
    if (component.handleChar(ch) === "handled") return true;
  }
  const bindings = topLevel === "log" ? LOG_CHAR_BINDINGS : INPUT_CHAR_BINDINGS;
  for (const { binding, run } of bindings) {
    if (matches({ toString: () => ch }, binding)) {
      run(globals);
      return true;
    }
  }
  return false;
}

/**
 * Cycle focus through the focusable components (`dir` +1 forward, -1
 * backward). Loss fires before gain so the outgoing component never sees
 * itself focused while the incoming one already is (legacy helper — the
 * top-level ring is driven by `setTopLevel`).
 */
export function cycleFocus(chain: readonly Component[], dir: 1 | -1): void {
  const focusables = chain.filter((c) => c.focusable);
  if (focusables.length === 0) return;
  const current = focusables.findIndex((c) => c.isFocused);
  const next =
    current === -1
      ? dir === 1
        ? 0
        : focusables.length - 1
      : (current + dir + focusables.length) % focusables.length;
  for (const c of focusables) {
    if (c.isFocused) c.onFocus(false);
  }
  (focusables[next] as Component).onFocus(true);
}
