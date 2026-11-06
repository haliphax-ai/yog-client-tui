/**
 * Notice formatting — the shared shape for every one-line chat-log signal
 * (`notice` and `error` entries): `<emoji> <event> [· detail]`.
 *
 * The *renderer* owns color and padding (it styles the line by entry kind and
 * the label's leading emoji); the emitter owns the emoji + wording, so the
 * pattern is decided in one place and every producer stays consistent.
 */

/** The one-line entry kinds this helper formats. */
export type NoticeKind = "notice" | "error";

/**
 * Event-specific emoji: known events keep their identity even though they all
 * share the generic `notice`/`error` kinds — keys are exact event names as
 * passed to `noticeLine`; the map is the single source of emoji identity.
 * Client lifecycle chatter (connection banner, session notes, recovery) keeps
 * the 🪧 tone; the rehydrated server-transcript system rows are transcript
 * content and never pass through here.
 */
const EVENT_EMOJI: Record<string, string> = {
  shake: "🧹",
  compact: "📦",
  handoff: "🤝",
  "turn aborted": "⏹️",
  "turn stopped": "⏹️",
  warning: "⚠️",
  connected: "🪧",
  model: "🪧",
  "new session": "🪧",
  "session resumed": "🪧",
  "session reset": "🪧",
  recovered: "🪧",
};

/** Pick the emoji for a notice line: event-specific first, kind fallback. */
function kindEmoji(kind: NoticeKind, event: string): string {
  const known = EVENT_EMOJI[event];
  if (known !== undefined) return known;
  return kind === "error" ? "❌" : "ℹ️";
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
