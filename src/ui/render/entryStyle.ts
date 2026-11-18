/**
 * Per-kind entry styling plus the focused variants of the styles the entry
 * renderer recolors on focus (user bubble, assistant border, tool block,
 * chunk block).
 *
 * The map is the single source of truth for which theme style an entry
 * kind wears; the focus helpers keep the base/focused style pairs next to
 * it so renderer and focus ring cannot drift apart.
 */
import type { Style } from "@oakoliver/lipgloss";
import { ST } from "../theme.ts";
import type { EntryKind } from "../../core/entries.ts";

/** Style for an entry kind. */
export function kindStyle(kind: EntryKind): Style {
  const byKind: Partial<Record<EntryKind, Style>> = {
    user: ST.user,
    assistant: ST.assistant,
    tool: ST.tool,
    toolResult: ST.tool,
    system: ST.system,
    error: ST.error,
    notice: ST.notice, // marker+label only; the detail row styles itself
    status: ST.statusLine,
    chunk: ST.chunkBlock,
    debug: ST.chunkBlock,
    placeholder: ST.system,
  };
  return byKind[kind] as Style;
}

/** The user bubble at `focused` — geometry is identical in both states, so
 *  focusing never reflows, it only swaps the palette. */
export function userBubbleStyle(focused: boolean): Style {
  return focused ? ST.userFocus : ST.user;
}

/** The assistant border at `focused`: the themed half-block rune switches
 *  to the focus blue ("black" edge). */
export function assistantBorderStyle(focused: boolean): Style {
  return focused ? ST.assistantBorderFocus : ST.assistantBorder;
}

/** The tool block at `focused` — same geometry, focus-only recolor, and
 *  expansion persists regardless of focus. */
export function toolBlockStyle(focused: boolean): Style {
  return focused ? ST.toolFocus : ST.toolPlain;
}

/** The chunk block at `focused`. */
export function chunkBlockStyle(focused: boolean): Style {
  return focused ? ST.chunkBlockFocus : ST.chunkBlock;
}
