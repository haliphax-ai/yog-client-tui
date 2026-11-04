/**
 * Slash-command vocabulary and matching for the input line.
 *
 * The autocomplete trigger is narrow by design: a slash only opens the
 * command menu when it is the very first character of the input line.
 * `slashToken` enforces exactly that (a slash anywhere else is ordinary
 * text). Commands are registry-driven — add a name + summary here and it
 * becomes completable overnight and executable via Enter.
 */

import { fuzzyFind } from "../util/fuzzy.ts";
export interface SlashCommand {
  readonly name: string;
  readonly summary: string;
}

/** The built-in slash commands (registry order is completion order). */
export const SLASH_COMMANDS: readonly SlashCommand[] = Object.freeze([
  { name: "quit", summary: "exit the client (session stays on the server)" },
]);

/**
 * Index just past the slash token: the first space after the leading "/",
 * or the end of the line when there is no space (a bare "/" yields 1).
 * Returns 0 when the line does not start with "/".
 */
export function slashTokenEnd(input: string): number {
  if (!input.startsWith("/")) return 0;
  const space = input.indexOf(" ", 1);
  return space === -1 ? input.length : space;
}

/**
 * The command token after the leading "/" ("" for a bare "/"), or null
 * when the line does not start with "/". This is the autocomplete gate.
 */
export function slashToken(input: string): string | null {
  if (!input.startsWith("/")) return null;
  return input.slice(1, slashTokenEnd(input));
}

/** True when the input line starts with "/" (the autocomplete trigger). */
export function isSlash(input: string): boolean {
  return input.startsWith("/");
}

/**
 * Completion candidates for the current slash line, ranked by fuzzy match
 * score (see `src/util/fuzzy.ts`): the typed token matches any command
 * whose name contains its characters in order, with better matches first.
 * An empty token (a lone "/") lists every command in registry order.
 */
export function completeSlash(input: string): readonly string[] {
  const token = slashToken(input);
  if (token === null) return [];
  return fuzzyFind(
    token,
    SLASH_COMMANDS.map((command) => command.name),
  ).map((match) => "/" + match.item);
}

/**
 * The command whose name exactly matches the typed token (case-insensitive),
 * or undefined when the line is not a slash command or names nothing known.
 */
export function resolveSlash(input: string): SlashCommand | undefined {
  const token = slashToken(input);
  if (token === null) return undefined;
  return SLASH_COMMANDS.find((command) => command.name.toLowerCase() === token.toLowerCase());
}
