/**
 * Drawer child registry: the ordered list of components the drawer draws.
 *
 * The drawer itself knows nothing about what it contains — anything (producer
 * components, plugins) contributes by calling `registerDrawerChild` and gets
 * an unregister function back. Order is registration order, exactly like the
 * render pipeline's hook registry: children draw top to bottom in the order
 * they registered, with no priority numbers.
 */
import type { Component } from "./Component.ts";

let children: Component[] = [];

/** Registered drawer children in registration (draw) order. */
export function registeredDrawerChildren(): readonly Component[] {
  return [...children];
}

/**
 * Add `child` to the drawer; returns a function that removes it again.
 * Registering the same component twice draws it twice — the caller owns
 * uniqueness, just like pipeline hooks.
 */
export function registerDrawerChild(child: Component): () => void {
  children.push(child);
  return () => {
    const i = children.indexOf(child);
    if (i >= 0) children.splice(i, 1);
  };
}

/** Test-only: drop every registered drawer child. */
export function resetDrawerRegistryForTests(): void {
  children = [];
}
