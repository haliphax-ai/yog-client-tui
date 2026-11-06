/**
 * Notice formatting — the shared shape for every one-line chat-log signal
 * (`notice`, `error`, and `system` entries): `<emoji> <event> [· detail]`.
 *
 * The *renderer* owns color and padding (it styles the whole line by entry
 * kind); the emitter owns the emoji + wording, so the pattern is decided in
 * one place and every producer stays consistent. A `null` detail drops the
 * dot separator entirely.
 */

/** The three one-line entry kinds this helper formats. */
export type NoticeKind = "notice" | "error" | "system";

/** Pick the severity emoji for a kind (used when an event name is generic). */
function kindEmoji(kind: NoticeKind): string {
  switch (kind) {
    case "error":
      return "❌";
    case "system":
      return "🪧";
  }
  return "ℹ️";
}

/**
 * Format one notice line: `<emoji> <event> · <detail>` (dot separator only
 * when a non-empty detail is given). `event` is the colored event name
 * ("shake", "turn aborted", "error", …); `detail` carries the specifics.
 */
export function noticeLine(kind: NoticeKind, event: string, detail?: string): string[] {
  const head = `${kindEmoji(kind)} ${event}`;
  const trimmed = detail?.trim() ?? "";
  return trimmed === "" ? [head] : [head, trimmed];
}
