/**
 * Bounded client-side transcript threading — pure, terminal-free.
 *
 * The transcript keeps 12 exchanges (user + assistant pairs, i.e. 24
 * messages); `buildPrompt` threads only the most recent window into the
 * next prompt, labeled `User:` / `Assistant:`, separated by blank lines.
 */

/** Bounded transcript size: 12 exchanges (user + assistant pairs). */
export const HISTORY_MESSAGES = 24;

/** One message of the client-side transcript history. */
export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
}

/**
 * Build the prompt: bounded transcript context + the new input.
 *
 * Only the last {@link HISTORY_MESSAGES} messages are threaded in; with an
 * empty history the raw input is returned untouched.
 */
export function buildPrompt(
  history: readonly HistoryMessage[],
  input: string,
  limit: number = HISTORY_MESSAGES,
): string {
  const recent = history.slice(-limit);
  if (recent.length === 0) return input;
  const blocks = recent.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`);
  blocks.push(`User: ${input}`);
  return blocks.join("\n\n");
}