/**
 * Tiny central UI state store — plain object, shallow-merge patches, and a
 * subscriber list so the render scheduler can be wired once instead of being
 * called at every mutation site. Terminal-free and dependency-free apart from
 * a type-only import of the log entry shape.
 */
import type { LogEntry } from "../ui/render/types.ts";

/** Application UI state held by the store. */
export interface UiState {
  entries: LogEntry[];
  input: string;
  cursor: number;
  inputScroll: number;
  scrollOffset: number;
  follow: boolean;
  busy: boolean;
  busyFrame: number;
  connection: "connecting" | "connected" | "error";
  model: string;
  statusNote: string;
  /** Focused log entry (-1 = none); Enter toggles chunk collapse. */
  focusIndex: number;
}

let state: UiState = initialState();

const listeners = new Set<() => void>();

function initialState(): UiState {
  return {
    entries: [],
    input: "",
    cursor: 0,
    inputScroll: 0,
    scrollOffset: 0,
    follow: true,
    busy: false,
    busyFrame: 0,
    connection: "connected",
    model: "",
    statusNote: "",
    focusIndex: -1,
  };
}

/** Current state snapshot (treat as read-only). */
export function getState(): Readonly<UiState> {
  return state;
}

/** Shallow-merge `patch` into the state and notify subscribers. */
export function setState(patch: Partial<UiState>): void {
  state = { ...state, ...patch };
  for (const listener of [...listeners]) listener();
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