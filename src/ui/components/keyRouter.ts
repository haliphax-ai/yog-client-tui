/**
 * Focus-scoped key routing: the focused component gets first crack at every
 * key, then the remaining components in chain order, then the global
 * bindings (quit, Tab focus cycle, scroll, submit). Replaces a hardcoded
 * sequence table — each responder only claims the keys it owns and returns
 * "unhandled" to let the rest bubble.
 *
 * The router owns no state of its own: it walks the chain, counts focusable
 * components for the Tab ring, and lets the responders do their work.
 */
import type { Component, KeyResult } from "./Component.ts";

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
}

/** Global bindings: sequences and chars no component claims while unfocused. */
const GLOBAL_KEYS: Record<string, (g: Globals) => void> = {
  "\x1b[Z": (g) => g.focusPrev(), // Shift+Tab → previous entry
  "\x1b[1;5H": (g) => g.jump(true), // Ctrl+Home → top
  "\x1b[1;5F": (g) => g.jump(false), // Ctrl+End → bottom
  "\x1b[5~": (g) => g.scrollBy(-(process.stdout.rows ?? 24)), // PageUp
  "\x1b[6~": (g) => g.scrollBy(process.stdout.rows ?? 24), // PageDown
  "\x1bOA": (g) => g.scrollBy(-1), // Up (application mode)
  "\x1bOB": (g) => g.scrollBy(1), // Down (application mode)
  "\x1b[A": (g) => g.scrollBy(-1), // Up
  "\x1b[B": (g) => g.scrollBy(1), // Down
};

/**
 * Route one key sequence: focused component first, then the rest of the
 * chain, then the globals. Returns whether anyone handled it.
 */
export function routeKey(
  chain: readonly Component[],
  seq: string,
  globals: Globals,
): boolean {
  const focused = chain.find((c) => c.isFocused);
  const walk = focused === undefined ? chain : [focused, ...chain.filter((c) => c !== focused)];
  for (const component of walk) {
    if (component.handleKey(seq) === "handled") return true;
  }
  const run = GLOBAL_KEYS[seq];
  if (run === undefined) return false;
  run(globals);
  return true;
}

/**
 * Route one decoded character with the same ordering as {@link routeKey}.
 * Unclaimed chars fall through to the global bindings (Tab, Enter, Ctrl+C).
 */
export function routeChar(
  chain: readonly Component[],
  ch: string,
  globals: Globals,
): boolean {
  const focused = chain.find((c) => c.isFocused);
  const walk = focused === undefined ? chain : [focused, ...chain.filter((c) => c !== focused)];
  for (const component of walk) {
    if (component.handleChar(ch) === "handled") return true;
  }
  switch (ch) {
    case "\x03":
      globals.quit(); // Ctrl+C in raw mode: quit and restore the terminal
      return true;
    case "\t":
      globals.focusNext(); // Tab: next component in the focus ring
      return true;
    case "\r":
    case "\n":
      globals.submit(); // Enter with no focused entry: send the input
      return true;
    default:
      return false;
  }
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