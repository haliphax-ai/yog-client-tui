/**
 * Harness-notice rendering — the synthetic `harness_notice` tool-call
 * pairs the server delivers (see the server's prelude sink): an
 * assistant call row with EMPTY args answered by a tool row whose
 * content is `{hint, notices: [{kind, body}]}`.
 *
 * One branch shared by BOTH producers of tool rows — the live turn path
 * (`turnEvents.ts`) and transcript rehydration (`rehydrateSteps.ts`) —
 * applied on the tool row the body lives in: the pair decodes to plain
 * notice lines (`<emoji> <kind>` + the body), never a 🔚 result blob.
 * The empty-args call row keeps grouping with its result through the
 * existing call/result pairing.
 *
 * Visibility is a build-time toggle (default: shown): when hidden, the
 * builders emit nothing for the notice pair (the call row and its ✅
 * remain — the transcript still carries them). Rows already in the log
 * were materialized when they arrived; the toggle applies from the next
 * notice pair (and to any transcript rebuild, which re-derives every
 * row through the same branch).
 */
import { noticeLine } from "./notices.ts";
import type { LogEntry } from "./entries.ts";

/** The reserved synthetic tool name (the server never advertises it). */
export const HARNESS_NOTICE_TOOL = "harness_notice" as const;

/** True when the tool name is the reserved harness-notice synthetic. */
export function isHarnessNoticeTool(name: string): boolean {
  return name === HARNESS_NOTICE_TOOL;
}

/** One decoded notice: a categorical `kind` plus the free-text `body`. */
export interface HarnessNotice {
  readonly kind: string;
  readonly body: string;
}

/**
 * Decode a `harness_notice` tool result into its notices. Strict on the
 * payload shape (`hint` string + `notices` array of `{kind, body}`
 * strings) so an ordinary tool result can never collide; `undefined`
 * when the value is not a harness-notice payload. An empty `notices`
 * array is a valid pair that renders nothing.
 */
export function decodeHarnessNotices(result: unknown): HarnessNotice[] | undefined {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return undefined;
  const rec = result as Record<string, unknown>;
  if (typeof rec["hint"] !== "string" || !Array.isArray(rec["notices"])) return undefined;
  const out: HarnessNotice[] = [];
  for (const item of rec["notices"]) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return undefined;
    const notice = item as Record<string, unknown>;
    if (typeof notice["kind"] !== "string" || typeof notice["body"] !== "string") return undefined;
    out.push({ kind: notice["kind"], body: notice["body"] });
  }
  return out;
}

/** Toggle state: harness notices render while shown (the default). */
let noticesVisible = true;

/** True while harness notices render (the build-time filter reads this). */
export function harnessNoticesShown(): boolean {
  return noticesVisible;
}

/** Show or hide harness notices (the `n` binding flips this). */
export function setHarnessNoticesVisible(visible: boolean): void {
  noticesVisible = visible;
}

/**
 * The log entries for one notice pair: a `notice` entry per notice
 * (`<emoji> <kind>` label + the dimmed body, word-wrapped by the
 * renderer). Nothing while the toggle hides them. Entries carry the
 * `harness` marker so producers can tell notice rows from other kinds.
 */
export function harnessNoticeEntries(notices: readonly HarnessNotice[]): LogEntry[] {
  if (!noticesVisible) return [];
  return notices.map((notice) => ({
    kind: "notice" as const,
    harness: true,
    lines: noticeLine("notice", notice.kind, notice.body),
  }));
}
