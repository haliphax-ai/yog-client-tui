/**
 * Slash-command execution for the composition root: local commands
 * (/quit, /new) and the server-advertised dispatch (bespoke handling for
 * the contract-stable message types, generic notice otherwise).
 *
 * The registry vocabulary lives in `core/commands.ts`; this module owns
 * the run-them side: gating, argument extraction, dispatch, and the
 * reply rendering.
 */
import { addLiveCompletionTokens, getState, setState } from "../core/store.ts";
import { FOCUS_NONE_TARGET } from "../core/focus.ts";
import { noticeLine } from "../core/notices.ts";
import { formatTokenTotal } from "../core/toolFormat.ts";
import {
  completeSlash,
  requiresArgs,
  resolveSlash,
  slashToken,
  slashTokenEnd,
  SLASH_COMMANDS,
  type SlashCommand,
} from "../core/commands.ts";
import type { YogClient } from "../yogClient.ts";
import { pushLines } from "./logFeed.ts";
import { compactionNote, applyCompaction } from "./transcriptRebuild.ts";
import { isSlash } from "../core/commands.ts";

/** Hooks the command runner needs from the composition root. */
export interface CommandEnv {
  client: YogClient;
  input: { reset(): void };
  spinner: { start(): void; stop(): void };
  quit(code: number): void;
  saveState(lastSessionId: string | null): Promise<void>;
}

/** The store patch /new applies: fresh session, cleared log, follow on. */
function freshSessionState(): void {
  setState({
    entries: [],
    scrollOffset: 0,
    follow: true,
    focusTarget: FOCUS_NONE_TARGET,
    tokenTotals: { prompt: 0, completion: 0, total: 0 },
  });
}

/** One rejected command line: the error notice with the available set. */
function unknownCommand(input: string): void {
  const token = slashToken(input) ?? "";
  const available = SLASH_COMMANDS.map((c) => "/" + c.name).join(", ");
  pushLines("error", noticeLine("error", "unknown command", `/${token} — available: ${available}`));
}

/** The "wait for the current turn" refusal. */
function busyWarning(command: SlashCommand): void {
  pushLines(
    "notice",
    noticeLine("notice", "warning", `wait for the current turn, then /${command.name}`),
  );
}

/** The missing-argument refusal. */
function missingArgument(command: SlashCommand): void {
  pushLines(
    "error",
    noticeLine(
      "error",
      "missing argument",
      `/${command.name} ${command.args ?? ""} — nothing given`,
    ),
  );
}

/** /new: a fresh server session with an empty chat log (requires idle). */
function runNew(env: CommandEnv): void {
  void (async () => {
    try {
      const id = await env.client.open();
      // Point the client at the fresh session and clear the log before
      // any next prompt is sent.
      freshSessionState();
      await env.saveState(id);
      pushLines("notice", noticeLine("notice", "new session", id));
    } catch (err) {
      pushLines(
        "error",
        noticeLine("error", "new session failed", err instanceof Error ? err.message : String(err)),
      );
    } finally {
      env.input.reset();
    }
  })();
}

/** The transcript.shake reply: reset the status-bar weight to the reply's. */
function applyShake(kind: string, reply: Record<string, unknown>): void {
  const weight = typeof reply["contextSize"] === "number" ? reply["contextSize"] : 0;
  setState({ tokenTotals: { prompt: 0, completion: 0, total: weight } });
  pushLines(
    "notice",
    noticeLine(
      "notice",
      kind,
      `${reply["argsTruncated"] ?? 0} arg(s), ` +
        `${reply["resultsTruncated"] ?? 0} result(s) truncated; ` +
        `totals reset to ~${formatTokenTotal(weight)}`,
    ),
  );
}

/** Server-advertised command dispatch: bespoke post-handling keyed on the
 *  contract-stable message type; anything else falls back to generic
 *  reply rendering. */
async function dispatchServerCommand(
  env: CommandEnv,
  command: SlashCommand,
  data: Record<string, unknown>,
): Promise<void> {
  env.spinner.start();
  try {
    const reply = await env.client.sendCommand(command.message as string, data);
    if (command.message === "transcript.shake") {
      applyShake(command.name, reply);
    } else if (command.message === "compaction.run") {
      // compact and handoff both start a fresh server session — adopt it
      // so a restart resumes the new session, not the archived one.
      const newSessionId = reply["sessionId"];
      if (typeof newSessionId === "string") {
        env.client.sessionId = newSessionId;
        await env.saveState(newSessionId);
      }
      applyCompaction(await env.client.getTranscript());
      compactionNote(command.name, reply);
    } else {
      // Generic fallback: every advertised command is usable with no
      // bespoke code — print the reply as a notice line.
      pushLines("notice", noticeLine("notice", command.name, JSON.stringify(reply)));
    }
  } catch (err) {
    pushLines(
      "error",
      noticeLine(
        "error",
        `${command.name} failed`,
        err instanceof Error ? err.message : String(err),
      ),
    );
  } finally {
    env.spinner.stop();
  }
}

/** A resolved command (fuzzy shortcut applied) or the refusal sentinel. */
export function resolveCommand(input: string): SlashCommand | undefined {
  let command = resolveSlash(input);
  // Fuzzy shortcut only applies when the token has no arguments (the
  // token runs to the end of the line). With arguments the user must use
  // Tab completion — we don't want to silently drop their text.
  const tokenEnd = slashTokenEnd(input);
  const hasArgs = tokenEnd < input.length;
  if (command === undefined && !hasArgs) {
    const matches = completeSlash(input);
    if (matches.length > 0) {
      command = resolveSlash(matches[0] as string);
    }
  }
  return command;
}

/** The local command handlers (`/quit`, `/new`) — undefined means the
 *  command is not local (fall through to server dispatch). */
function localCommand(env: CommandEnv, command: SlashCommand): (() => void) | undefined {
  if (command.name === "quit") return () => env.quit(0);
  if (command.name !== "new") return undefined;
  // Starting a fresh session while a turn is in flight would orphan that
  // turn's events, so require the current turn to finish first.
  if (getState().busy) return () => busyWarning(command);
  return () => runNew(env);
}

/** The server command dispatch (descriptors from capabilities): requires-
 *  idle gates like /new; required args (the "<name>" convention) refuse
 *  to fire without one. */
function serverCommand(env: CommandEnv, command: SlashCommand, prompt: string): void {
  if (command.message === undefined) return; // local-only command
  if (command.requiresIdle === true && getState().busy) {
    busyWarning(command);
    return;
  }
  const rest = prompt.slice(slashTokenEnd(prompt)).trim();
  if (requiresArgs(command) && rest === "") {
    missingArgument(command);
    return;
  }
  const data: Record<string, unknown> = {
    ...command.data,
    ...(command.argField !== undefined ? { [command.argField]: rest } : {}),
  };
  void dispatchServerCommand(env, command, data);
}

/** Run the resolved command (or refuse). Every path clears the input —
 *  the command line is consumed whether it ran, was gated, or failed. */
export function executeCommand(env: CommandEnv, prompt: string): void {
  const command = resolveCommand(prompt);
  env.input.reset();
  if (command === undefined) {
    unknownCommand(prompt);
    return;
  }
  const local = localCommand(env, command);
  if (local !== undefined) {
    local();
    return;
  }
  serverCommand(env, command, prompt);
}

/** True when the input line is a slash command (the submit gate). */
export function isCommand(prompt: string): boolean {
  return isSlash(prompt);
}

/** The round-delta hook the turn path needs (kept here so the turn wiring
 *  in main.ts stays a two-liner). */
export function roundDelta(delta: number): void {
  addLiveCompletionTokens(delta);
}
