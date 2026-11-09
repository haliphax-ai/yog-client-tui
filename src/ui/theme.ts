/**
 * Single source of color truth: the lipgloss style map, the ANSI palette for
 * tool-call colorization, chunk-header colors, and the glamour theme name.
 * Everything color-related lives here so the rest of the UI imports styles
 * and palettes instead of literals.
 */
import { innerHalfBlockBorder, newStyle } from "@oakoliver/lipgloss";

/** Purple accent for the input: the prompt marker and the input's left border. */
export const INPUT_PURPLE = "#a78bfa";

/** Styling map. Tool-output blocks: black bg, dark grey text, 1-cell padding. */
export const ST = {
  /** Prompt: dark grey bg, light grey text, 1-cell padding, no margin. */
  user: newStyle().foreground("#d4d4d8").background("#3f3f46").padding(1),
  /** Response: normal background, white text; spacing comes from the uniform entry separator. */
  assistant: newStyle().foreground("#ffffff"),
  /** Assistant prose left border: blue right-half block on every row. */
  assistantBorder: newStyle().foreground("#60a5fa"),
  tool: newStyle().foreground("#a78bfa"),
  /** System chatter: connection notes, lifecycle messages. */
  system: newStyle().foreground("#94a3b8"),
  /** Informational notice: `ℹ️` event label light blue, detail dim. The
   *  label carries no padding of its own: the notice BLOCK shape (one
   *  pre-wrapped line) gets its true 1-cell padding from `noticeBlock`, so
   *  the whole wrapped block — every row — is padded, not just the label. */
  notice: newStyle().foreground("#7dd3fc"),
  noticeDetail: newStyle().foreground("#a1a1aa"),
  /** The notice block shape: pre-wrapped content (one logical line, wrapped
   *  at cols-2) wrapped in this style, which applies 1-cell horizontal
   *  padding to EVERY row of the block. */
  noticeBlock: newStyle().padding(0, 1),
  /** Wait notice: `⚠️` busy-gate refusals, yellow. Shares the notice layout. */
  noticeWait: newStyle().foreground("#fbbf24"),
  /** Lifecycle notice: `🪧` client chatter (connection banner, session notes,
   *  recovery), blue-grey. Shares the notice layout. */
  noticeSystem: newStyle().foreground("#94a3b8"),
  /** Per-turn summary line: very dark grey text on the normal background, 1-cell
   *  horizontal padding (unlike the session status bar, which has a backing). */
  statusLine: newStyle().foreground("#3f3f46").padding(0, 1),
  error: newStyle().foreground("#ef4444").bold(true),
  /** Tool block (unfocused): black bg, dark grey text, 1-cell padding. */
  chunkBlock: newStyle().foreground("#a1a1aa").background("#000000").padding(1),
  /** Tool block (focused): white text on dark blue, same padding. */
  chunkBlockFocus: newStyle().foreground("#ffffff").background("#1e3a8a").padding(1),
  /** Prompt (focused): white text on dark blue — the bubble's geometry is
   *  identical in both states, focus only recolors. */
  userFocus: newStyle().foreground("#ffffff").background("#1e3a8a").padding(1),
  /** Tool call (unfocused): transparent bg, purple text, same padding. */
  toolPlain: newStyle().foreground("#a78bfa").padding(0, 1),
  /** Focused tool call: dark blue bar, white text (same padding — no jitter). */
  toolFocus: newStyle().foreground("#ffffff").background("#1e3a8a").padding(0, 1),
  promptMarker: newStyle().foreground(INPUT_PURPLE).bold(true),

  /** Input textarea base: black backing with 1-cell horizontal padding and a
   *  purple right-half-block left border (same purple as the prompt marker). */
  inputBase: newStyle()
    .background("#000000")
    .padding(0, 1)
    .borderLeft(true)
    .borderStyle(innerHalfBlockBorder())
    .borderLeftForeground(INPUT_PURPLE),
  inputText: newStyle(),
  /** Input text when the input is blurred (log holds the top-level ring). */
  inputTextBlur: newStyle().foreground("#52525b"),
  cursor: newStyle().background("#7c3aed").foreground("#ffffff").bold(true),
  /** Status bar: dark grey backing, black text by default. */
  status: newStyle().background("#3f3f46").foreground("#000000"),
  /** Busy label: spinner + "generating" in bright purple. */
  generating: newStyle().foreground("#c084fc").bold(true),
  /** Drawer block: 1-cell padding on every side. */
  drawer: newStyle().padding(1),
  /** Zebra-striped data row in table rendering: white text on dark blue. */
  tableZebra: newStyle().foreground("#ffffff").background("#1a1a2e"),
  /** Focused table border: blue runes (the focus indicator — not a row bg). */
  tableBorderFocused: newStyle().foreground("#60a5fa"),
  /** Assistant prose left border (focused): the same right-half block rune
   *  rendered in the focus blue — the "black" the issue asks for. The
   *  terminal's bg is the theme's dark base; a literal black bg on a
   *  bare rune would paint a hard rectangle over the prose instead of
   *  recoloring the edge. */
  assistantBorderFocus: newStyle().foreground("#1e3a8a"),
  /** Zebra-striped data row in a FOCUSED table: white text on the focus
   *  blue. The plain zebra and this share a white fg, so a focused table's
   *  data rows stay readable when the blue focus paint lands on them.
   *  Applied in place of the plain zebra while the table is focused. */
  tableZebraFocused: newStyle().foreground("#ffffff").background("#1e3a8a"),
  /** Unfocused table border: plain white runes so the border is always
   *  visible regardless of stale SGR state from a previously-focused
   *  table rendered above. */
  tableBorderUnfocused: newStyle().foreground("#ffffff"),
  /** Slash-command menu: unselected candidate. */
  suggestion: newStyle().foreground("#94a3b8"),
  /** Slash-command menu: selected candidate. */
  suggestionSel: newStyle().foreground("#ffffff").background("#7c3aed").bold(true),
} as const;
/** Input textarea: the virtual cursor block color (mirrors ST.cursor). */
export const CURSOR_COLOR = "#7c3aed";
/** Input textarea: the virtual cursor block color when the input is blurred. */
export const CURSOR_COLOR_BLUR = "#4c1d95";

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

/** Chunk header colors (truecolor foregrounds): plain, exit 0, failure. */
export const CHUNK_HEADER = {
  plain: "\x1b[38;2;255;255;255m",
  ok: "\x1b[38;2;0;255;0m", // bright green
  fail: "\x1b[38;2;255;0;0m", // bright red
} as const;

/** Context window fill colors (truecolor foregrounds), low → high fill. */
export const CONTEXT_WINDOW = {
  brightGreen: "\x1b[38;2;0;255;0m", // <= 10%
  green: "\x1b[38;2;0;200;0m", // <= 25%
  yellow: "\x1b[38;2;255;255;0m", // <= 50%
  orange: "\x1b[38;2;255;165;0m", // <= 75%
  red: "\x1b[38;2;255;0;0m", // > 75%
  // Back to the status bar's foreground (black) — a default-fg reset would
  // punch a white hole into the bar's dark backing.
  reset: "\x1b[38;2;0;0;0m",
} as const;
