/**
 * Frame scheduler: coalesces rapid state changes into one pipeline run per
 * `FRAME_MS` window so a burst of SSE deltas cannot flood stdout. It
 * subscribes to the central state store once; the pipeline runs on flush.
 *
 * Semantics: the first change arms a timer for `FRAME_MS`; later changes
 * while the timer is pending are collapsed into that single flush; the
 * timer is cleared when it fires, so the next change arms a fresh window.
 */
import { subscribe } from "../../core/store.ts";

/** Render coalescing interval so SSE deltas do not flood stdout. */
export const FRAME_MS = 16;

/** Handle for a scheduler bound to a store subscription. */
export interface Scheduler {
  /** Arm the coalescing timer (no-op while a flush is already pending). */
  request(): void;
  /** Cancel a pending flush (used on shutdown). */
  cancel(): void;
  /** Run the callback on the next flush immediately (timer cleared first). */
  flush(): void;
  /** Drop the store subscription and any pending flush. */
  dispose(): void;
}

/**
 * Create a scheduler that flushes `run` at most once per `FRAME_MS` window,
 * and subscribe it to the store so every `setState` requests a flush.
 * `windowMs` exists for tests; production uses `FRAME_MS`.
 */
export function createScheduler(run: () => void, windowMs: number = FRAME_MS): Scheduler {
  let timer: NodeJS.Timeout | undefined;
  const unsubscribe = subscribe(request);

  function request(): void {
    if (timer !== undefined) return;
    timer = setTimeout(flush, windowMs);
  }

  function flush(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    run();
  }

  function cancel(): void {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  }

  function dispose(): void {
    cancel();
    unsubscribe();
  }

  return { request, cancel, flush, dispose };
}