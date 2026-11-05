/**
 * Tiny central UI state store — plain object, shallow-merge patches, and a
 * subscriber list so the render scheduler can be wired once instead of being
 * called at every mutation site. Terminal-free and dependency-free apart from
 * a type-only import of the log entry shape.
 */
import type { LogEntry } from "./entries.ts";
import { FOCUS_NONE_TARGET, type FocusTarget } from "./focus.ts";

/** Application UI state held by the store. */
export interface UiState {
  entries: LogEntry[];
  input: string;
  /** Selected slash-command completion index (resets on any text edit). */
  commandSel: number;
  scrollOffset: number;
  follow: boolean;
  busy: boolean;
  busyFrame: number;
  connection: "connecting" | "connected" | "error";
  model: string;
  statusNote: string;
  /** Focused table target (`{entry:-1, table:-1}` = none); Enter toggles. */
  focusTarget: FocusTarget;
  /** Running session token totals (reset on /new). */
  tokenTotals: { prompt: number; completion: number; total: number };
  /** Context window size for the session model (from server capabilities). */
  contextWindow?: number;
}

let state: UiState = initialState();

const listeners = new Set<() => void>();

function initialState(): UiState {
  return {
    entries: [],
    input: "",
    commandSel: 0,
    scrollOffset: 0,
    follow: true,
    busy: false,
    busyFrame: 0,
    connection: "connected",
    model: "",
    statusNote: "",
    tokenTotals: { prompt: 0, completion: 0, total: 0 },
    contextWindow: undefined,
    focusTarget: FOCUS_NONE_TARGET,
  };
}

/** Current state snapshot (treat as read-only). */
export function getState(): Readonly<UiState> {
  return state;
}

/** Shallow-merge `patch` into the state and notify subscribers. */
export function setState(patch: Partial<UiState>): void {
  state = { ...state, ...patch };
  for (const listener of Array.from(listeners)) listener();
}

/**
 * Fold per-call completion tokens into the running session total as they
 * arrive live (tool results), so the status-bar 🪙 stat climbs while tools
 * run. The terminal usage report (`applyUsageTotal` in main.ts) later
 * replaces these provisional totals with the authoritative full-context
 * numbers, so nothing double-counts.
 */
export function addLiveCompletionTokens(count: number): void {
  if (!Number.isFinite(count) || count <= 0) return;
  const t = state.tokenTotals;
  setState({
    tokenTotals: { prompt: t.prompt, completion: t.completion + count, total: t.total + count },
  });
}

/** Subscribe to state changes; returns an unsubscribe function. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: restore the default state and drop all listeners. */
export function resetForTests(): void {
  state = initialState();
  listeners.clear();
}
