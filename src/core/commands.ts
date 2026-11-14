/**
 * Slash-command registry and matching for the input line.
 *
 * The autocomplete trigger is narrow by design: a slash only opens the
 * command menu when it is the very first character of the input line.
 * `slashToken` enforces exactly that (a slash anywhere else is ordinary
 * text).
 *
 * The registry has two sources, merged by name:
 *
 * - **Local commands** — client-owned lifecycle (`new`, `quit`). Frozen
 *   at module scope; a server has no business naming these.
 * - **Server-advertised commands** — `CommandDescriptor`s from the
 *   capabilities reply. Applied once at startup via `setServerCommands`;
 *   the registry does not mutate mid-session. Descriptors merge under
 *   their local names unless a local command already owns the name (local
 *   wins; dropped descriptors are debug-warned by the caller).
 *
 * Dispatch is keyed on `message`, never on the slash name: the name is
 * client-side sugar and never sent to the server.
 */

import { fuzzyFind } from "../util/fuzzy.ts";

/** One server-advertised slash command (mirrors the daemon wire shape). */
export interface CommandDescriptor {
  /** Slash token clients complete after "/", without the leading slash. */
  readonly name: string;
  /** One-liner for the autocomplete menu. */
  readonly summary: string;
  /** Argument syntax hint; a leading "<" marks a required argument. */
  readonly args?: string;
  /** The messages-channel type an invocation dispatches. */
  readonly message: string;
  /** Static payload merged into every invocation. */
  readonly data?: Readonly<Record<string, unknown>>;
  /** The `data` field free-text line args land in (single remainder string). */
  readonly argField?: string;
  /** True when the client must wait for an idle turn before dispatching. */
  readonly requiresIdle?: boolean;
}

/** One completable slash command: a local entry or a server descriptor. */
export interface SlashCommand {
  readonly name: string;
  readonly summary: string;
  /** Argument syntax shown instead of the summary on an exact-match menu. */
  readonly args?: string;
  /**
   * Defined for server-advertised commands only: the messages-channel
   * `type` an invocation dispatches. Local commands have no `message` —
   * they are handled client-side.
   */
  readonly message?: string;
  /** Static payload merged into every invocation (server commands only). */
  readonly data?: Readonly<Record<string, unknown>>;
  /** The `data` field free-text line args land in (server commands only). */
  readonly argField?: string;
  /** True when the client must wait for an idle turn before dispatching. */
  readonly requiresIdle?: boolean;
}

/** Local (client-owned) commands. `new` and `quit` win every name collision. */
export const LOCAL_COMMANDS: readonly SlashCommand[] = Object.freeze([
  { name: "new", summary: "start a fresh session with an empty chat log" },
  { name: "quit", summary: "exit the client (session stays on the server)" },
]);

/** Bumped on every `setServerCommands` so memoized views re-derive. */
export let registryVersion = 0;

/** Server-advertised commands merged under the local set, registry order. */
let serverCommands: readonly SlashCommand[] = [];

/** The merged registry, cached on the version: rebuilt only when the
 *  server command list actually changes. */
let registryCache: { version: number; value: readonly SlashCommand[] } | null = null;

function registry(): readonly SlashCommand[] {
  if (registryCache === null || registryCache.version !== registryVersion) {
    registryCache = {
      version: registryVersion,
      value: Object.freeze([...LOCAL_COMMANDS, ...serverCommands]),
    };
  }
  return registryCache.value;
}

/**
 * The full registry, exposed as a stable module identity: a proxy whose
 * traps (`ownKeys`, `getOwnPropertyDescriptor`, `get`, `has`) all route to
 * the current merged snapshot, so spread, iteration, `map`, `find`, and
 * index access read live data without re-deriving per call site. Nothing
 * writes through this proxy — the registry is mutated only by
 * `setServerCommands`. Descriptors come back configurable regardless of the
 * snapshot's freeze (a proxy may not report non-configurable props its
 * target lacks), which is harmless: the snapshot itself stays frozen.
 */
export const SLASH_COMMANDS: readonly SlashCommand[] = new Proxy(
  {} as unknown as readonly SlashCommand[],
  {
    ownKeys: () => Reflect.ownKeys(registry()).filter((key) => key !== "length"),
    getOwnPropertyDescriptor: (_target, prop) => {
      if (prop === "length") return undefined;
      const descriptor = Reflect.getOwnPropertyDescriptor(registry(), prop);
      return descriptor === undefined ? undefined : { ...descriptor, configurable: true };
    },
    get: (_target, prop) =>
      prop === Symbol.iterator
        ? Reflect.get(registry(), Symbol.iterator)
        : (Reflect.get(registry(), prop) as unknown),
    has: (_target, prop) => Reflect.has(registry(), prop),
  },
) as readonly SlashCommand[];

/**
 * Apply the capabilities reply's command descriptors to the registry.
 * Bumps `registryVersion` every call so `SLASH_BY_NAME` and menu
 * memoization re-derive. Returns the descriptors rejected on a name
 * collision with a local command (local wins).
 */
export function setServerCommands(
  descriptors: readonly CommandDescriptor[],
): readonly CommandDescriptor[] {
  const rejected: CommandDescriptor[] = [];
  const merged: SlashCommand[] = [];
  for (const descriptor of descriptors) {
    if (LOCAL_COMMANDS.some((local) => local.name === descriptor.name)) {
      rejected.push(descriptor);
      continue;
    }
    merged.push({
      name: descriptor.name,
      summary: descriptor.summary,
      ...(descriptor.args !== undefined ? { args: descriptor.args } : {}),
      message: descriptor.message,
      ...(descriptor.data !== undefined ? { data: descriptor.data } : {}),
      ...(descriptor.argField !== undefined ? { argField: descriptor.argField } : {}),
      ...(descriptor.requiresIdle === true ? { requiresIdle: true } : {}),
    });
  }
  serverCommands = Object.freeze(merged);
  registryVersion += 1;
  return rejected;
}

/** True when the command requires an argument (the `args` starts with "<"). */
export function requiresArgs(command: SlashCommand): boolean {
  return typeof command.args === "string" && command.args.startsWith("<");
}

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
    registry().map((command) => command.name),
  ).map((match) => "/" + match.item);
}

/**
 * The command whose name exactly matches the typed token (case-insensitive),
 * or undefined when the line is not a slash command or names nothing known.
 */
export function resolveSlash(input: string): SlashCommand | undefined {
  const token = slashToken(input);
  if (token === null) return undefined;
  return registry().find((command) => command.name.toLowerCase() === token.toLowerCase());
}
