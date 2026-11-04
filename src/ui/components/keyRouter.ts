/**
 * Focus-scoped key routing with a top-level focus ring: the chat log and
 * the text input are the two ring targets, and the ring decides which
 * component receives keys at all.
 *
 * - While the input is the ring target, the browser receives ALL keys:
 *   editing keys are translated to the textarea model, and the few
 *   app-level keys (Enter submit, Esc abort, Shift+Up → log) are carved out.
 * - While the log is the ring target, the log receives the keys (Tab /
 *   Shift-Tab cycle its focusable units; Home/End/PageUp/PageDown/arrows
 *   operate the viewport; Shift+Down or Esc-on-empty returns to the input).
 *   Unhandled keys are dropped — they are never passed to the input.
 * - While the input is the ring target, the input receives ALL keys:
 * Components opt into the ring with the optional `ring` property ("log" or
 * "input"). When no component declares a ring (legacy setups/tests), the
 * router falls back to the previous focused-first ordering.
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
 * Global bindings: sequences no component claims while the log is the ring
 * target. Log-side navigation (scroll/jump + entry-focus cycling) lives
 * here; input-side global actions (submit, abort) are gated to the input
 * ring target inside the handlers.
 */
const GLOBAL_BINDINGS: { binding: Binding; run: (g: Globals) => void }[] = [
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
    binding: newBinding(withKeys("\x1bOA"), withHelp("Up", "scroll up one line")),
    run: (g) => g.scrollBy(-1),
  },
  {
    binding: newBinding(withKeys("\x1bOB"), withHelp("Down", "scroll down one line")),
    run: (g) => g.scrollBy(1),
  },
  {
    binding: newBinding(withKeys("\x1b[A"), withHelp("Up", "scroll up one line")),
    run: (g) => g.scrollBy(-1),
  },
  {
    binding: newBinding(withKeys("\x1b[B"), withHelp("Down", "scroll down one line")),
    run: (g) => g.scrollBy(1),
  },
];

/**
 * Char-level global bindings: single control characters. Tab cycles the
 * log's entry focus ring only while the log is the ring target; Enter/Esc
 * stay input-side (the log consumes its own Enter/Esc semantics first).
 */
const CHAR_BINDINGS: { binding: Binding; run: (g: Globals, legacy: boolean) => boolean }[] = [
  {
    binding: newBinding(withKeys("\t"), withHelp("Tab", "next entry")),
    run: (g, legacy) => {
      if (legacy || topLevel === "log") {
        g.focusNext();
        return true;
      }
      return false;
    },
  },
  {
    binding: newBinding(withKeys("\r", "\n"), withHelp("Enter", "send input")),
    run: (g, legacy) => {
      if (legacy || topLevel === "input") {
        g.submit();
        return true;
      }
      return false;
    },
  },
  {
    binding: newBinding(withKeys("\x1b"), withHelp("Esc", "abort turn")),
    run: (g, legacy) => {
      if (legacy || topLevel === "input") {
        g.abortTurn();
        return true;
      }
      return false;
    },
  },
];

/**
 * The components that may receive keys for the current ring target. When the
 * ring is wired (components declare `ring`), only that side is consulted —
 * the other side never sees a key. Unset ring falls back to legacy ordering.
 */
function ringWired(chain: readonly Component[]): boolean {
  return chain.some((c) => c.ring !== undefined);
}

function ringWalk(chain: readonly Component[]): readonly Component[] {
  const side = chain.filter((c) => c.ring === topLevel);
  if (side.length > 0) return side;
  const focused = chain.find((c) => c.isFocused);
  return focused === undefined ? chain : [focused, ...chain.filter((c) => c !== focused)];
}

/**
 * Route one key sequence: the ring target's components, then the globals.
 * Returns whether anyone handled it (false = dropped).
 */
export function routeKey(chain: readonly Component[], seq: string, globals: Globals): boolean {
  for (const component of ringWalk(chain)) {
    if (component.handleKey(seq) === "handled") return true;
  }
  for (const { binding, run } of GLOBAL_BINDINGS) {
    if (matches({ toString: () => seq }, binding)) {
      run(globals);
      return true;
    }
  }
  return false;
}

/**
 * Route one decoded character through the same ring ordering. Unclaimed chars
 * fall through to the gated global bindings (Tab/Enter/Esc).
 */
export function routeChar(chain: readonly Component[], ch: string, globals: Globals): boolean {
  for (const component of ringWalk(chain)) {
    if (component.handleChar(ch) === "handled") return true;
  }
  for (const { binding, run } of CHAR_BINDINGS) {
    if (matches({ toString: () => ch }, binding)) {
      if (run(globals, !ringWired(chain))) return true;
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
