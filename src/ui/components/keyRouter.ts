/**
 * Focus-scoped key routing: the focused component gets first crack at every
 * key, then the remaining components in chain order, then the global
 * bindings (quit, Tab entry-focus cycle, scroll, submit). Replaces a hardcoded
 * sequence table — each responder only claims the keys it owns and returns
 * "unhandled" to let the rest bubble.
 *
 * The router owns no state of its own: it walks the chain and lets the
 * responders do their work.
 */
import type { Component, KeyResult } from "./Component.ts";
import { Binding, matches, newBinding, withHelp, withKeys } from "@oakoliver/bubbles";

/** Global binding handlers supplied by the composition root. */
export interface Globals {
  /** Ctrl+C: quit the application. */
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
}

/**
 * Global bindings: sequences no component claims while unfocused.
 * Each binding carries its own help text — the router walks them in
 * declaration order and the first match wins. `matches()` does the
 * comparison; the handler is stored alongside because `Binding` itself
 * has no callback slot.
 */
const GLOBAL_BINDINGS: { binding: Binding; run: (g: Globals) => void }[] = [
  {
    binding: newBinding(withKeys("\x1b[Z"), withHelp("Shift+Tab", "previous entry")),
    run: (g) => g.focusPrev(),
  },
  {
    binding: newBinding(withKeys("\x1b[1;5H"), withHelp("Ctrl+Home", "jump to top")),
    run: (g) => g.jump(true),
  },
  {
    binding: newBinding(withKeys("\x1b[1;5F"), withHelp("Ctrl+End", "jump to bottom")),
    run: (g) => g.jump(false),
  },
  {
    binding: newBinding(withKeys("\x1b[5~"), withHelp("PageUp", "scroll up one page")),
    run: (g) => g.scrollBy(-(process.stdout.rows ?? 24)),
  },
  {
    binding: newBinding(withKeys("\x1b[6~"), withHelp("PageDown", "scroll down one page")),
    run: (g) => g.scrollBy(process.stdout.rows ?? 24),
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
 * Char-level global bindings: single control characters no component
 * claims while unfocused. Same `Binding` + `matches()` pattern as the
 * sequence-level globals above.
 */
const CHAR_BINDINGS: { binding: Binding; run: (g: Globals) => void }[] = [
  {
    binding: newBinding(withKeys("\x03"), withHelp("Ctrl+C", "quit")),
    run: (g) => g.quit(),
  },
  {
    binding: newBinding(withKeys("\t"), withHelp("Tab", "next entry")),
    run: (g) => g.focusNext(),
  },
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
 * Route one key sequence: focused component first, then the rest of the
 * chain, then the globals. Returns whether anyone handled it.
 */
export function routeKey(chain: readonly Component[], seq: string, globals: Globals): boolean {
  const focused = chain.find((c) => c.isFocused);
  const walk = focused === undefined ? chain : [focused, ...chain.filter((c) => c !== focused)];
  for (const component of walk) {
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
 * Route one decoded character with the same ordering as {@link routeKey}.
 * Unclaimed chars fall through to the global bindings (Tab, Enter, Ctrl+C).
 */
export function routeChar(chain: readonly Component[], ch: string, globals: Globals): boolean {
  const focused = chain.find((c) => c.isFocused);
  const walk = focused === undefined ? chain : [focused, ...chain.filter((c) => c !== focused)];
  for (const component of walk) {
    if (component.handleChar(ch) === "handled") return true;
  }
  for (const { binding, run } of CHAR_BINDINGS) {
    if (matches({ toString: () => ch }, binding)) {
      run(globals);
      return true;
    }
  }
  return false;
}

/** A component plus a router-assigned id (the focus ring is over these). */
export interface Routed {
  id: string;
  component: Component;
}

/**
 * Cycle focus through the focusable components (`dir` +1 forward, -1
 * backward). Loss fires before gain so the outgoing component never sees
 * itself focused while the incoming one already is.
 */
export function cycleFocus(chain: readonly Routed[], dir: 1 | -1): void {
  const focusables = chain.filter((r) => r.component.focusable);
  if (focusables.length === 0) return;
  const current = focusables.findIndex((r) => r.component.isFocused);
  const next =
    current === -1
      ? dir === 1
        ? 0
        : focusables.length - 1
      : (current + dir + focusables.length) % focusables.length;
  for (const r of focusables) {
    if (r.component.isFocused) r.component.onFocus(false);
  }
  (focusables[next] as Routed).component.onFocus(true);
}
