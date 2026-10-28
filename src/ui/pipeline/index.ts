/**
 * Render pipeline: a fixed stage runner (layout → paint → compose → post →
 * emit) with per-stage hooks registered in explicit order, a store-backed
 * frame coalescing scheduler, and the single frame writer.
 *
 * The composition root wires host callbacks (geometry, painting, writing)
 * into `runPipeline` and lets the scheduler flush it; features hook into
 * stages with `register(stage, hook)` without touching the core files.
 */
export { STAGES, isStage, type Stage } from "./stages.ts";
export {
  register,
  registeredHooks,
  hooksFor,
  resetRegistryForTests,
  type HookRegistry,
  type StageHook,
} from "./registry.ts";
export { runPipeline, type RunOptions } from "./runner.ts";
export { createScheduler, FRAME_MS, type Scheduler } from "./scheduler.ts";
export { writeFrame } from "./emit.ts";
export { padFrame, padLine, type FrameLines } from "./lines.ts";