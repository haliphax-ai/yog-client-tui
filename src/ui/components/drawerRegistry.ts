/**
 * Drawer child registry — the single hook point for ANYTHING that wants
 * to live in the drawer (producers, plugins, future features).
 *
 * Registration is the hook: `registerDrawerChild` adds a component to the
 * draw order and returns its unregister function. There is no other way
 * to get into the drawer, and no drawer-specific knowledge is required —
 * a child is an ordinary `Component` that renders its own rows (including
 * rendering nothing when it has nothing to say).
 *
 * Two optional capabilities ride the SAME hook, because they are drawer
 * behaviors a child may want and the drawer itself stays dumb:
 *
 * - **dismissal** — implement `dismiss()` (`DrawerDismissable`); `Esc`
 *   walks the registered children newest-first and the first child that
 *   actually closes something claims the key. A child that renders
 *   nothing right now must return false so the cascade keeps falling.
 * - **command hooks** — `registerDrawerCommand` adds a local slash
 *   command owned by a drawer child (`DrawerCommand`); the registry
 *   feeds the vocabulary to `core/commands` so `/anything` resolves to
 *   the child that declared it. This replaces per-feature hand-wiring in
 *   the composition root: a drawer child that wants a command declares
 *   it here, and any future feature gets both behaviors for free.
 *
 * Order is registration order, exactly like the render pipeline's hook
 * registry — no priority numbers. The caller owns uniqueness, just like
 * pipeline hooks.
 */
import type { Component } from "./Component.ts";
import type { SlashCommand } from "../../core/index.ts";

/**
 * A drawer child that can be dismissed (an `Esc` responder). The drawer
 * registry walks these newest-first in the Esc cascade; returning false
 * means "not mine / nothing to close" and the cascade continues.
 */
export interface DrawerDismissable {
  /** Close whatever this child has open; true when it did. */
  dismiss(): boolean;
}

/** A local slash command a drawer child owns (client-side only). */
export interface DrawerCommand {
  /** The command shape (no `message` — client-local by construction). */
  readonly command: Omit<SlashCommand, "message">;
  /** Invoked when the command runs. Return false to refuse. */
  readonly run: () => boolean | void;
  /** The refusal note shown when `run` returned false (or the child is
   *  unavailable — e.g. its server subsystem is not wired). */
  readonly refusal?: () => void;
}

/** The optional command surface a drawer child may expose. */
export interface DrawerCommandProvider {
  /** The child's own commands (invoked once at registration). */
  drawerCommands?(): readonly DrawerCommand[];
}

let children: Component[] = [];
let commands: DrawerCommand[] = [];

/** Registered drawer children in registration (draw) order. */
export function registeredDrawerChildren(): readonly Component[] {
  return [...children];
}

/** The drawer commands (registration order; the slash registry consumes). */
export function drawerCommands(): readonly DrawerCommand[] {
  return [...commands];
}

/**
 * Add `child` to the drawer; returns a function that removes it again
 * (its commands with it). Registering the same component twice draws it
 * twice — the caller owns uniqueness, just like pipeline hooks.
 */
export function registerDrawerChild(child: Component): () => void {
  const provider = child as Partial<DrawerCommandProvider>;
  const own =
    typeof provider.drawerCommands === "function" ? [...provider.drawerCommands()] : [];
  children.push(child);
  commands.push(...own);
  // Unregister removes the child's DRAW and its commands: a detached
  // component must never keep a live slash command.
  return () => {
    const i = children.indexOf(child);
    if (i >= 0) children.splice(i, 1);
    commands = commands.filter((entry) => !own.includes(entry));
  };
}

/**
 * The `Esc` cascade's drawer arm: the newest registered child that closes
 * something claims the key. True when a child dismissed (the cascade
 * stops); false when none did (the cascade keeps falling).
 */
export function dismissDrawerChildren(): boolean {
  for (let i = children.length - 1; i >= 0; i -= 1) {
    const child = children[i] as Partial<DrawerDismissable>;
    if (typeof child.dismiss === "function" && child.dismiss() === true) return true;
  }
  return false;
}

/** The drawer commands as slash-registry entries (client-local: no message). */
export function drawerSlashCommands(): readonly SlashCommand[] {
  return commands.map(({ command }) => ({ ...command, message: undefined }));
}

/** Run the drawer command registered under `name`; undefined when none.
 *  A `false` return from `run` shows the entry's refusal note. */
export function runDrawerCommand(name: string): (() => void) | undefined {
  const entry = commands.find(({ command }) => command.name === name);
  if (entry === undefined) return undefined;
  return () => {
    if (entry.run() === false) entry.refusal?.();
  };
}

/** Test-only: drop every registered child and command. */
export function resetDrawerRegistryForTests(): void {
  children = [];
  commands = [];
}
