/**
 * Clipboard writer for the copy feature: spawn `wl-copy` with the
 * content on stdin. The only non-stdlib dependency is the wl-clipboard
 * binary the issue names; a missing binary or a spawn/exec failure
 * surfaces as a structured error (never a throw) so the caller can show
 * an error notice instead of crashing the TUI.
 *
 * This lives in `ui/` as the clipboard SINK: the composition root wires
 * it, `core/` decides WHAT to copy (see core/copyText.ts), and no other
 * layer touches processes.
 */
import { spawnSync } from "node:child_process";

/** Outcome of a wl-copy attempt: ok, or the human-readable failure. */
export type CopyOutcome = { ok: true } | { ok: false; error: string };

/**
 * Write `content` to the Wayland clipboard via `wl-copy` (stdin → paste
 * buffer; wl-copy daemonizes after reading, so the synchronous spawn
 * returns once the content is handed over — no waiting on a paste).
 * Returns `{ok:false}` with the reason when wl-copy is missing or fails.
 */
export function runWlCopy(content: string): CopyOutcome {
  try {
    const result = spawnSync("wl-copy", [], {
      input: content,
      // stdio: the child reads our stdin; let its own stdout/stderr be
      // inherited so a wl-copy diagnostic is not silently swallowed.
      stdio: ["pipe", "inherit", "inherit"],
    });
    if (result.error !== undefined) {
      const code = (result.error as NodeJS.ErrnoException).code;
      return {
        ok: false,
        error:
          code === "ENOENT"
            ? "wl-copy not found — install wl-clipboard (Wayland)"
            : `wl-copy failed: ${result.error.message}`,
      };
    }
    if (result.status !== 0) {
      return { ok: false, error: `wl-copy exited ${result.status ?? "abnormally"}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
