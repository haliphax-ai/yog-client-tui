/**
 * The submit→turn pipeline for the composition root: turn one input line
 * into either a slash-command run or a client turn, with the spinner,
 * usage tracking, the submit-time transcript sync (#135), and the failure
 * paths wired.
 */
import { getState, setState } from "../core/index.ts";
import { createTurnPresenter, type TurnPresenter } from "../core/index.ts";
import { turnWithRecovery, applyUsageTotal } from "./turnControl.ts";
import { executeCommand, isCommand, roundDelta } from "./slashCommands.ts";
import { pushLines, nextMessageSeq } from "./logFeed.ts";
import { syncTranscriptOnSubmit } from "./transcriptRebuild.ts";

/** What the runner needs from the composition root. */
export interface TurnEnv {
  client: import("../client/index.ts").YogClient;
  model: string;
  input: { reset(): void };
  spinner: { start(): void; stop(): void };
  scheduler: { request(): void };
  quit(code: number): void;
  saveState(lastSessionId: string | null): Promise<void>;
}

/** Run the async turn to its outcome, reporting failures through the
 *  presenter's fail path; always stop the spinner and finish the turn. */
async function driveTurn(env: TurnEnv, presenter: TurnPresenter, prompt: string): Promise<void> {
  try {
    const outcome = await turnWithRecovery(
      env.client,
      env.model,
      prompt,
      presenter.events,
      env.saveState,
    );
    if (!outcome.ok) {
      const detail = outcome.failure ?? outcome.error;
      if (detail) presenter.fail(detail);
    }
  } catch (err) {
    presenter.fail(err instanceof Error ? err.message : String(err));
  } finally {
    env.spinner.stop();
    presenter.finish();
    // The turn's events may have appended to the shared entries array
    // in place.
    setState({ entries: getState().entries });
  }
}

/** Attach the terminal usage tracking to the presenter's events: each
 *  terminal usage report (finished or aborted at a cut point) carries the
 *  latest full-context total, which replaces the stored totals rather
 *  than being added on top. */
function wireUsageTracking(presenter: TurnPresenter): void {
  const baseOnFinish = presenter.events.onFinish;
  presenter.events.onFinish = (durationMs, stopReason, usage) => {
    baseOnFinish?.(durationMs, stopReason, usage);
    if (usage !== undefined) applyUsageTotal(usage);
  };
  const baseOnAborted = presenter.events.onAborted;
  presenter.events.onAborted = (reason, usage) => {
    baseOnAborted?.(reason, usage);
    if (usage !== undefined) applyUsageTotal(usage);
  };
}

/**
 * Submit the input line. A line beginning with "/" is a slash command:
 * resolved against the registry and run instead of being sent as a prompt.
 * Commands bypass the busy gate (e.g. /quit must work mid-turn). Plain
 * prompts are ignored while a turn is in flight (one turn at a time).
 *
 * A prompt submit first runs the transcript sync (#135): when the server
 * transcript advanced while the TUI sat idle (a server wake turn, another
 * client's turn), those rows are rebuilt into the log BEFORE the new
 * prompt enters it — the prompt must never sit ahead of rows the server
 * already persisted before it. The probe is best effort; its contract is
 * `syncTranscriptOnSubmit`.
 */
export function submitInput(env: TurnEnv, rawInput: string): void {
  const prompt = rawInput.trim();
  if (prompt === "") return;

  // Slash command path (works even while a turn is in flight).
  if (isCommand(prompt)) {
    executeCommand(
      {
        client: env.client,
        input: env.input,
        spinner: env.spinner,
        quit: env.quit,
        saveState: env.saveState,
      },
      prompt,
    );
    return;
  }

  if (getState().busy) return; // one turn at a time (documented)

  // The submit-time sync (#135): render any turns that ran while the TUI
  // sat idle, so this prompt appends after them (never ahead of rows the
  // server already persisted). Then the baseline read below sees the
  // post-sync transcript weight, keeping the delta this turn's own.
  void (async () => {
    await syncTranscriptOnSubmit(env.client);
    startTurn(env, prompt);
  })();
}

/** The turn assembly the sync hands back to: baseline, presenter, wire,
 *  and the async drive to the outcome. Extracted so the sync can run
 *  first without the submit path forking into duplicated setup. */
function startTurn(env: TurnEnv, prompt: string): void {
  // Baseline the session total BEFORE any live tool-result token accrual:
  // the per-turn delta must stay this turn's own contribution, not the
  // live-updated running total.
  const turnStartTotal = getState().tokenTotals.total;
  const presenter = createTurnPresenter({
    entries: getState().entries,
    append: pushLines,
    width: () => process.stdout.columns ?? 80,
    requestRender: env.scheduler.request,
    nextMessageSeq,
    prevTokenTotal: () => turnStartTotal,
    onRoundDelta: roundDelta,
  });
  wireUsageTracking(presenter);
  presenter.begin(prompt);
  env.input.reset();
  setState({ follow: true });
  env.spinner.start();
  void driveTurn(env, presenter, prompt);
}
