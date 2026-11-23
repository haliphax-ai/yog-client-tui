/**
 * The slash-command autocomplete menu: the candidate list (fuzzy) and the
 * exact-command args view, rendered from the theme.
 *
 * Shown only when the input starts with "/" (the trigger) and at least one
 * command matches. Once the command token resolves — typed exactly or with
 * args — the args view replaces the list; the list only returns when the
 * input no longer matches up (partial/unknown token). The selected
 * candidate is highlighted; Tab cycles through and applies the selection.
 */
import { displayWidth, truncateAnsi, wrapText } from "../../util/index.ts";
import { ST } from "../theme.ts";
import {
  SLASH_COMMANDS,
  completeSlash,
  registryVersion,
  resolveSlash,
  type SlashCommand,
} from "../../core/index.ts";

/** Maximum rows the slash autocomplete menu shows (candidates in ranked order). */
export const MAX_MENU_ROWS = 5;

/**
 * Slash-command lookup by "/name", version-stamped on the command
 * registry: server descriptors land after module init (capabilities probe),
 * so a once-built map would go stale. Rebuilt only when the registry
 * version changes — the render hot path reads it per frame.
 */
let slashByNameCache: { version: number; value: Map<string, SlashCommand> } | null = null;

function slashByName(): Map<string, SlashCommand> {
  if (slashByNameCache === null || slashByNameCache.version !== registryVersion) {
    slashByNameCache = {
      version: registryVersion,
      value: new Map(SLASH_COMMANDS.map((command) => ["/" + command.name, command])),
    };
  }
  return slashByNameCache.value;
}

/** A candidate's label: the command name without its "/" trigger. */
function labelOf(candidate: string): string {
  return candidate.startsWith("/") ? candidate.slice(1) : candidate;
}

/** The padded head of one candidate row: lead + label aligned to the widest. */
function candidateHead(index: number, label: string, labelW: number): string {
  const lead = index === 0 ? "↹ " : "  ";
  return lead + label + " ".repeat(labelW - displayWidth(label) + 2);
}

/** The description truncated to `room` cells ("" when the room is too small
 *  to hold anything readable). */
function candidateDesc(summary: string, room: number): string {
  if (displayWidth(summary) <= room) return summary;
  return room >= 2 ? truncateAnsi(summary, room - 1) + "…" : "";
}

/** The fuzzy list body: one styled row per shown candidate. */
function renderList(candidates: readonly string[], selected: number, cols: number): string {
  const shown = candidates.slice(0, MAX_MENU_ROWS);
  const byName = slashByName();
  const labels = shown.map(labelOf);
  const labelW = Math.max(...labels.map((label) => displayWidth(label)), 0);
  const body: string[] = [];
  for (const [index, label] of labels.entries()) {
    const command = byName.get(shown[index] as string);
    const head = candidateHead(index, label, labelW);
    const room = Math.max(0, cols - displayWidth(head));
    const desc = candidateDesc(command?.summary ?? "", room);
    const style = index === selected ? ST.suggestionSel : ST.suggestion;
    body.push(style.width(cols).render(head + desc));
  }
  return body.join("\n");
}

/** Single-command view: highlighted header + dim flush-left description. */
function renderExact(command: SlashCommand, cols: number): string {
  const head = command.name + " ";
  const body: string[] = [ST.suggestionSel.width(cols).render(head + (command.args ?? ""))];
  for (const wline of wrapText(command.summary, cols)) {
    body.push(ST.suggestion.render(wline));
  }
  return body.join("\n");
}

/**
 * The menu body for the input state: the args view for a resolved command,
 * the ranked candidate list while typing, or "" when nothing matches.
 * `commandSel` is clamped into the list's bounds.
 */
export function slashMenu(input: string, commandSel: number, cols: number): string {
  const resolved = resolveSlash(input);
  if (resolved !== undefined) return renderExact(resolved, cols);
  const candidates = completeSlash(input);
  if (candidates.length === 0) return "";
  const selected = Math.max(0, Math.min(commandSel, candidates.length - 1));
  return renderList(candidates, selected, cols);
}
