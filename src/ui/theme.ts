/**
 * Single source of color truth: the lipgloss style map, the ANSI palette for
 * tool-call colorization, chunk-header colors, and the glamour theme name.
 * Everything color-related lives here so the rest of the UI imports styles
 * and palettes instead of literals.
 */
import { newStyle } from "@oakoliver/lipgloss";

/** Styling map. Tool-output blocks: black bg, dark grey text, 1-cell padding. */
export const ST = {
  /** Prompt: dark grey bg, light grey text, 1-cell padding, no margin. */
  user: newStyle()
    .foreground("#d4d4d8")
    .background("#3f3f46")
    .padding(1),
  /** Response: normal background, white text; spacing comes from the uniform entry separator. */
  assistant: newStyle().foreground("#ffffff"),
  /** Assistant prose left border: blue right-half block on every row. */
  assistantBorder: newStyle().foreground("#60a5fa"),
  tool: newStyle().foreground("#a78bfa"),
  /** System chatter: connection notes, lifecycle messages. */
  system: newStyle().foreground("#94a3b8"),
  /** Terminal-state notice: `⏹` marker + event label bright, detail dim. */
  notice: newStyle().foreground("#fbbf24").padding(0, 1),
  noticeDetail: newStyle().foreground("#a1a1aa"),
  error: newStyle().foreground("#ef4444").bold(true),
  /** Tool block (unfocused): black bg, dark grey text, 1-cell padding. */
  chunkBlock: newStyle()
    .foreground("#a1a1aa")
    .background("#000000")
    .padding(1),
  /** Tool block (focused): white text on dark blue, same padding. */
  chunkBlockFocus: newStyle()
    .foreground("#ffffff")
    .background("#1e3a8a")
    .padding(1),
  /** Tool call (unfocused): transparent bg, purple text, same padding. */
  toolPlain: newStyle().foreground("#a78bfa").padding(0, 1),
  /** Focused tool call: dark blue bar, white text (same padding — no jitter). */
  toolFocus: newStyle().foreground("#ffffff").background("#1e3a8a").padding(0, 1),
  promptMarker: newStyle().foreground("#a78bfa").bold(true),
  inputText: newStyle(),
  cursor: newStyle().background("#7c3aed").foreground("#ffffff").bold(true),
  status: newStyle().foreground("#64748b"),
  /** Zebra-striped data row in table rendering: white text on dark blue. */
  tableZebra: newStyle()
    .foreground("#ffffff")
    .background("#1a1a2e"),
  /** Selected row in table rendering: white text on dark blue. */
  tableSelected: newStyle()
    .foreground("#ffffff")
    .background("#1e3a8a"),
} as const;

/** ANSI palette for tool-call line colorization (foreground-only codes). */
export const C = {
  key: "\x1b[38;5;39m",
  str: "\x1b[38;5;114m",
  num: "\x1b[38;5;215m",
  lit: "\x1b[38;5;213m",
  punct: "\x1b[38;5;245m",
  ok: "\x1b[38;5;41m",
  fail: "\x1b[38;5;203m",
  reset: "\x1b[39m", // fg only — a full reset would punch holes in focus-bar bg
} as const;

/** Glamour markdown theme name. */
export const GLAMOUR_THEME = "tokyo-night";

/** SGR tones for inline-markdown styling in table cells (theme-owned so no
 * other module carries raw color escapes). */
export const TONE = {
  /** Inline `code` in table cells: tokyo-night comment green. */
  code: "\x1b[38;2;158;206;106m",
} as const;

/** Chunk header colors (truecolor foregrounds): plain, exit 0, failure. */
export const CHUNK_HEADER = {
  plain: "\x1b[38;2;255;255;255m",
  ok: "\x1b[38;2;0;255;0m", // bright green
  fail: "\x1b[38;2;255;0;0m", // bright red
} as const;