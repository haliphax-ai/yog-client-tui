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

/** Status line body: parts joined by the mid-dot separator. */
export function statusBody(): string {
  const state = getState();
  const parts: string[] = [];
  if (state.busy) parts.push(`${spinnerFrame()} thinking…`);
  if (state.statusNote !== "") parts.push(state.statusNote);
  parts.push(`model ${state.model}`);
  parts.push(state.connection === "connected" ? "session ok" : state.connection);
  parts.push("Tab focus · PgUp/PgDn scroll · Enter send · Ctrl+C quit");
  return parts.join("  ·  ");
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