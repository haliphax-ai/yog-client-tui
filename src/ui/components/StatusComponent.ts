/**
 * Status line: busy spinner, note, model, session state, and key hints.
 * Pure derivation from the store — no keys, no focus, single row.
 */
import { BaseComponent, type RenderContext } from "./Component.ts";
import { getState } from "../../core/store.ts";
import { ST } from "../theme.ts";

/** Busy spinner frames, animated in the status line while a turn runs. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Spinner frame for the current `busyFrame` (undefined while idle). */
export function spinnerFrame(): string {
  return SPINNER[getState().busyFrame % SPINNER.length] as string;
}

/**
 * Status line body: three segments — transient activity (spinner, note),
 * session state (model · connection), key hints. Segments are separated by
 * a vertical box-drawing line; the mid-dot separates items within a
 * segment (the key-hints segment uses the dot among its own items).
 */
export function statusBody(): string {
  const state = getState();
  const activity: string[] = [];
  if (state.busy) activity.push(`${spinnerFrame()} thinking…`);
  if (state.statusNote !== "") activity.push(state.statusNote);
  const session = [`model ${state.model}`, state.connection === "connected" ? "session ok" : state.connection];
  const segments: string[] = [];
  if (activity.length > 0) segments.push(activity.join(" · "));
  segments.push(session.join(" · "));
  segments.push("Tab focus · PgUp/PgDn scroll · Enter send · Ctrl+C quit");
  return segments.join(" │ ");
}

export class StatusComponent extends BaseComponent {
  constructor() {
    super(false);
  }

  /** One styled status row derived from the store (frame post pads/truncates). */
  render(_ctx: RenderContext): string {
    return ST.status.render(statusBody());
  }

  /** Rows this component occupies: always a single line. */
  measure(_width: number): number {
    return 1;
  }
}