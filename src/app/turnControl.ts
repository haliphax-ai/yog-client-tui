/**
 * Turn lifecycle for the composition root: running one turn with stale-
 * session recovery, applying the terminal usage reports to the status
 * bar, and aborting the in-flight turn.
 *
 * The transport stays behind the `client` handle; everything here is
 * plain data + store writes.
 */
import { addLiveCompletionTokens, getState, setState } from "../core/index.ts";
import { noticeLine } from "../core/index.ts";
import { createTurnPresenter, type TurnPresenter } from "../core/index.ts";
import {
  type TokenUsage,
  type TurnEvents,
  type TurnOutcome,
  type YogClient,
  YogError,
} from "../client/index.ts";
import { pushLines } from "./logFeed.ts";

/** Save the resolved session id (the caller injects its own state writer). */
export type StateSaver = (lastSessionId: string | null) => Promise<void>;

/** Terminal width (columns); 80 when headless. The input bar wraps there. */
export function turnWidth(): number {
  return process.stdout.columns ?? 80;
}

/**
 * Apply a terminal usage report to the status-bar 🪙 stat: the report
 * carries the latest full-context total, which replaces the stored totals
 * rather than being added on top. Missing fields keep the previous value
 * so a partial report never zeroes a known running total.
 */
export function applyUsageTotal(usage: TokenUsage): void {
  const prev = getState().tokenTotals;
  setState({
    tokenTotals: {
      prompt: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : prev.prompt,
      completion:
        typeof usage.completion_tokens === "number" ? usage.completion_tokens : prev.completion,
      total: typeof usage.total_tokens === "number" ? usage.total_tokens : prev.total,
    },
  });
}

/** Wrap the presenter's events so terminal usage reports update the bar. */
export function withUsageTracking(presenter: TurnPresenter): TurnEvents {
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
  return presenter.events;
}

/**
 * Run one turn, sending only the new prompt (the server hydrates prior
 * context from its canonical transcript). A stale session id — the server
 * purged or pruned it — restarts with a fresh session, notes the fallback,
 * and replays the turn once against the new id.
 */
export async function turnWithRecovery(
  client: YogClient,
  model: string,
  prompt: string,
  events: TurnEvents,
  saveState: StateSaver,
): Promise<TurnOutcome> {
  try {
    return await client.runTurn(prompt, model, events);
  } catch (err) {
    if (!(err instanceof YogError) || err.code !== "unknown_session") throw err;
    const staleId = client.sessionId;
    const freshId = await client.open();
    pushLines(
      "notice",
      noticeLine("notice", "session reset", `id ${staleId} is gone — started fresh`),
    );
    pushLines("notice", noticeLine("notice", "new session", freshId));
    await saveState(freshId);
    return await client.runTurn(prompt, model, events);
  }
}

/**
 * Abort the in-flight turn (Esc with no focused entry): send the
 * `turn.abort` message. The session stream frames the terminal
 * `turn.aborted` event, which settles `runTurn` and stops the spinner
 * through the normal completion path — the abort call itself only fires
 * the request. A transport failure here is logged; the turn keeps
 * running either way.
 */
export function abortActiveTurn(client: YogClient): void {
  if (!getState().busy || client.sessionId === undefined) return;
  void client
    .abortTurn()
    .then((result) => {
      // The reply names what WAS killed (captured server-side before the
      // unwind): surface it — the turn-abort path otherwise has no log
      // footprint until the settled turn carries its `turn.aborted` notice.
      const call = result.activeToolCall;
      pushLines(
        "notice",
        noticeLine(
          "notice",
          "turn aborted",
          call === undefined ? undefined : `${call.name} ${call.id}`,
        ),
      );
    })
    .catch((err: unknown) => {
      pushLines(
        "error",
        noticeLine("error", "abort failed", err instanceof Error ? err.message : String(err)),
      );
    });
}

/** Create the presenter for a new prompt, with usage tracking wired. */
export function startTurnPresenter(host: Parameters<typeof createTurnPresenter>[0]): {
  presenter: TurnPresenter;
  events: TurnEvents;
} {
  const presenter = createTurnPresenter(host);
  return { presenter, events: withUsageTracking(presenter) };
}

/** Fold one round's promptDelta into the live session total (the round
 *  attribution the store handles). */
export function recordRoundDelta(delta: number): void {
  addLiveCompletionTokens(delta);
}
