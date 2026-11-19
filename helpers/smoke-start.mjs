#!/usr/bin/env node
/**
 * Startup smoke check — CI guard for "the app can even load".
 *
 * Spawns `npm start` with stdin/stdout detached from a TTY and asserts the
 * process reaches the app's own non-TTY guard: a clean stderr message and
 * exit 1. That proves every module in the startup graph loaded through the
 * real runtime transpiler (tsx) — the class of regression where a
 * `tsc --noEmit`-clean tree dies at import (`ERR_UNSUPPORTED_TYPESCRIPT_
 * SYNTAX` under Node's strip-only TS mode) before `main()` runs.
 *
 * The TUI itself needs a TTY and is not exercised here; CI has none.
 *
 * Usage: node helpers/smoke-start.mjs
 * Exits 0 when the guard is reached; 1 with a diagnosis on stderr otherwise.
 */

import { spawn } from "node:child_process";

const GUARD = "requires an interactive terminal";
const TIMEOUT_MS = 30_000;

const child = spawn("npm", ["start"], {
  stdio: ["ignore", "ignore", "pipe"],
  env: { ...process.env, NO_COLOR: "1" },
});

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const timer = setTimeout(() => {
  child.kill("SIGKILL");
  console.error(`smoke-start: no exit within ${TIMEOUT_MS / 1000}s (did the TTY guard fire?)`);
  process.exit(1);
}, TIMEOUT_MS);

child.on("error", (err) => {
  clearTimeout(timer);
  console.error(`smoke-start: could not run npm start: ${err.message}`);
  process.exit(1);
});

child.on("close", (code, signal) => {
  clearTimeout(timer);
  if (signal !== null) {
    console.error(`smoke-start: npm start was killed by ${signal} before exiting`);
    process.exit(1);
  }
  if (stderr.includes(GUARD) && code === 1) {
    process.exit(0); // the expected, correct non-TTY failure
  }
  console.error(`smoke-start: unexpected outcome (exit ${code}); stderr:`);
  console.error(stderr.trim() || "(empty)");
  console.error(
    GUARD === stderr || !stderr.includes(GUARD)
      ? `smoke-start: the startup graph failed to load, or the TTY guard is gone`
      : `smoke-start: the guard fired but the exit code was ${code}, not 1`,
  );
  process.exit(1);
});
