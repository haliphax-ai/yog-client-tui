/**
 * Harness-notice rendering — the synthetic `harness_notice` tool-call
 * pairs the server delivers (see the server prelude sink): an
 * assistant call row with EMPTY args answered by a tool row whose
 * content is `{hint, notices: [{kind, body, tool?, result?}]}`.
 *
 * One branch shared by BOTH producers of tool rows — the live turn path
 * (`turnEvents.ts`) and transcript rehydration (`rehydrateSteps.ts`) —
 * applied on the tool row the body lives in: the pair decodes to plain
 * notice lines (`<emoji> <kind>` + the body), never a blob of the
 * harness payload itself. A notice carrying an attached tool result
 * (background jobs: the job's settled `{stdout, stderr, …}`, already
 * capped at the tool boundary) renders that result through the shared
 * tool-result components — exactly like any live tool call's output.
 * The call row renders nothing: all information lives in the result.
 *
 * Visibility is a build-time toggle (default: shown): when hidden, the
 * builders emit nothing for the notice pair (the transcript still
 * carries them). Rows already in the log were materialized when they
 * arrived; the toggle applies from the next notice pair (and to any
 * transcript rebuild, which re-derives every row through the same
 * branch).
 */
import { noticeLine } from "./notices.ts";
import { toolResultEntries } from "./toolEntries.ts";
import type { LogEntry } from "./entries.ts";

/** The reserved synthetic tool name (the server never advertises it). */
export const HARNESS_NOTICE_TOOL = "harness_notice" as const;

/** One decoded notice: a categorical `kind`, the free-text `body`, and
 * — on background-job notices — the attached tool result (`tool` names
 * it; `result` is the settled payload exactly as the tool produced it).
 * Both fields are optional; every other producer keeps the plain shape.
 */
/** True when the tool name is the reserved harness-notice synthetic. */
export function isHarnessNoticeTool(name: string): boolean {
  return name === HARNESS_NOTICE_TOOL;
}
/** One decoded notice: a categorical `kind`, the free-text `body`, and
 * — on background-job notices — the attached tool result (`tool` names
 * it; `result` is the settled payload exactly as the tool produced it).
 * Both fields are optional; every other producer keeps the plain shape.
 */
export interface HarnessNotice {
  readonly kind: string;
  readonly body: string;
  readonly tool?: string;
  readonly result?: unknown;
}

/**
 * Decode a `harness_notice` tool result into its notices. Strict on the
 * payload shape (`hint` string + `notices` array of `{kind, body}`
 * strings) so an ordinary tool result can never collide; `undefined`
 * when the value is not a harness-notice payload. An empty `notices`
 * array is a valid pair that renders nothing. An attached tool result
 * (`tool` string + any `result` value) rides through untouched — the
 * result is tool-shaped data, already capped at the tool boundary, and
 * strictness stops at the notice envelope.
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
    out.push({
      kind: notice["kind"],
      body: notice["body"],
      ...(typeof notice["tool"] === "string" ? { tool: notice["tool"] } : {}),
      ...("result" in notice ? { result: notice["result"] } : {}),
    });
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
 * renderer), followed by the attached tool result's entries when the
 * notice carries one — the same `toolResultEntries` builders every
 * live tool call and rehydrated row uses, so bash output gets the
 * collapsible chunk and any other shape the generic block. The result
 * entries are NOT `harness` rows: they are the tool's own output.
 * Nothing while the toggle hides them. Notice entries carry the
 * `harness` marker so producers can tell notice rows from other kinds.
 */
export function harnessNoticeEntries(notices: readonly HarnessNotice[]): LogEntry[] {
  if (!noticesVisible) return [];
  return notices.flatMap((notice) => [
    {
      kind: "notice" as const,
      harness: true,
      lines: noticeLine("notice", notice.kind, notice.body),
    },
    ...(notice.tool === undefined || notice.result === undefined
      ? []
      : toolResultEntries(notice.tool, notice.result, 0)),
  ]);
}
