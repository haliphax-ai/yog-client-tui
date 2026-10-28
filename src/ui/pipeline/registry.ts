/**
 * Hook registry for the render pipeline.
 *
 * `register(stage, hook)` appends to an ordered array per stage: ordering is
 * the registration order itself (no priority numbers to reason about). Hooks
 * run after the stage's core work, each one receiving and returning the
 * current frame so later hooks see earlier hooks' output.
 */
import { STAGES, type Stage } from "./stages.ts";

/** One stage hook: takes the current frame, returns the frame to continue with. */
export type StageHook = (frame: string) => string;

/** Ordered hook lists, one array per stage (empty when nothing is registered). */
export type HookRegistry = Readonly<Record<Stage, readonly StageHook[]>>;

function emptyRegistry(): Record<Stage, StageHook[]> {
  return { layout: [], paint: [], compose: [], post: [], emit: [] };
}

let registry: Record<Stage, StageHook[]> = emptyRegistry();

/** Ordered hooks registered for `stage` (registration order). */
export function hooksFor(stage: Stage): readonly StageHook[] {
  return registry[stage];
}

/** A snapshot of all stage hook lists, ordered per stage. */
export function registeredHooks(): HookRegistry {
  return { ...registry };
}

/** Append `hook` to `stage`'s ordered hook list; returns an unregister function. */
export function register(stage: Stage, hook: StageHook): () => void {
  const list = registry[stage];
  list.push(hook);
  return () => {
    const i = list.indexOf(hook);
    if (i >= 0) list.splice(i, 1);
  };
}

/** Test-only: drop every registered hook. */
export function resetRegistryForTests(): void {
  registry = emptyRegistry();
}