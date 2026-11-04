/**
 * Status line: busy spinner, note, session state, and session stats.
 * Pure derivation from the store — no keys, no focus, single row.
 */
import { BaseComponent, type RenderContext } from "./Component.ts";
import { getState, type UiState } from "../../core/store.ts";
import { ST } from "../theme.ts";
import { displayWidth, stripAnsi } from "../../util/ansi.ts";
import type { LogEntry } from "../../core/entries.ts";
import { MiniDot } from "@oakoliver/bubbles";

/** Busy spinner frames (Bubbles `MiniDot` preset — byte-identical to our hand-rolled array). */
export const SPINNER = MiniDot.frames;

/** Spinner frame for the current `busyFrame` (undefined while idle). */
export function spinnerFrame(): string {
  return SPINNER[getState().busyFrame % SPINNER.length] as string;
}

/** Emoji labels — all already full-width, so no variation selectors are
 *  needed (ℹ️ would have required one; 🔌 does not). */
const USER_EMOJI = "\u{1F464}"; // 👤 bust in silhouette
const SESSION_EMOJI = "\u{1F50C}"; // 🔌 electric plug
const TURNS_EMOJI = "\u{1F504}"; // 🔄 refresh
const TOOLS_EMOJI = "\u{1F527}"; // 🔧 wrench

/** Session counters derived from the log: one turn per user message, one
 *  tool call per ⚙️ call entry. */
export function sessionStats(entries: readonly LogEntry[]): {
  turns: number;
  toolCalls: number;
} {
  let turns = 0;
  let toolCalls = 0;
  for (const entry of entries) {
    if (entry.kind === "user") turns += 1;
    else if (entry.kind === "tool") toolCalls += 1;
  }
  return { turns, toolCalls };
}

/** Activity items (spinner + note), empty while idle. */
function activityItems(state: Readonly<UiState>): string[] {
  const items: string[] = [];
  if (state.busy) items.push(`${spinnerFrame()} generating`);
  if (state.statusNote !== "") items.push(state.statusNote);
  return items;
}

/** Plain status body: activity · session · stats, separated by vertical bars.
 *  Stats are separated by two spaces (🔄 2  🔧 27). */
export function statusBody(): string {
  const state = getState();
  const stats = sessionStats(state.entries);
  const segments: string[] = [];
  const activity = activityItems(state);
  if (activity.length > 0) segments.push(activity.join(" · "));
  segments.push(
    `${USER_EMOJI} ${state.model} · ${SESSION_EMOJI} ${
      state.connection === "connected" ? "ok" : state.connection
    }`,
  );
  segments.push(`${TURNS_EMOJI} ${stats.turns}  ${TOOLS_EMOJI} ${stats.toolCalls}`);
  return segments.join(" │ ");
}

export class StatusComponent extends BaseComponent {
  constructor() {
    super(false);
  }

  /** One styled status row: dark grey backing across the full width, black
   *  text by default, and the spinner/"generating" label in bright purple. */
  override render(ctx: RenderContext): string {
    const state = getState();
    const activity: string[] = [];
    if (state.busy) {
      activity.push(ST.generating.render(`${spinnerFrame()} generating`));
    }
    if (state.statusNote !== "") activity.push(ST.status.render(state.statusNote));
    const stats = sessionStats(state.entries);
    const session = [
      ST.status.render(`${USER_EMOJI} ${state.model}`),
      ST.status.render(
        `${SESSION_EMOJI} ${state.connection === "connected" ? "ok" : state.connection}`,
      ),
    ].join(ST.status.render(" · "));
    const statsLine = ST.status.render(
      `${TURNS_EMOJI} ${stats.turns}  ${TOOLS_EMOJI} ${stats.toolCalls}`,
    );
    const segments: string[] = [];
    if (activity.length > 0) segments.push(activity.join(ST.status.render(" · ")));
    segments.push(session, statsLine);
    const row = segments.join(ST.status.render(" │ "));
    const cols = Math.max(1, ctx.cols);
    const pad = Math.max(0, cols - displayWidth(stripAnsi(row)));
    return row + ST.status.render(" ".repeat(pad));
  }

  /** Rows this component occupies: always a single line. */
  measure(_width: number): number {
    return 1;
  }
}
