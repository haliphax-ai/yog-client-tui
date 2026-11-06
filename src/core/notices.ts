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

/**
 * Event-specific emoji: known events keep their identity even though they all
 * share the generic `notice`/`system` kinds — ℹ️ (the kind fallback) stays a
 * true fallback for anything unlisted. Keys are exact event names as passed
 * to `noticeLine`; the map is the single source of truth, so adding an event
 * here restores its emoji everywhere it is emitted.
 */
const EVENT_EMOJI: Record<string, string> = {
  shake: "🧹",
  compact: "📦",
  handoff: "📦",
  "turn aborted": "⏹️",
  "turn stopped": "⏹️",
  warning: "⚠️",
};

/** Pick the emoji for a notice line: event-specific first, kind fallback. */
function kindEmoji(kind: NoticeKind, event: string): string {
  const known = EVENT_EMOJI[event];
  if (known !== undefined) return known;
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
  const head = `${kindEmoji(kind, event)} ${event}`;
  const trimmed = detail?.trim() ?? "";
  return trimmed === "" ? [head] : [head, trimmed];
}
