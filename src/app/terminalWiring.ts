/**
 * Terminal wiring for the composition root: the component chain, the
 * draw loop (the staged render pipeline), the scheduler, the copy/output
 * sinks, quit, the global key bindings, and the raw-input decoder.
 *
 * One object assembled once; `main.ts` seeds the store, then turns the
 * key handlers on. Nothing here parses input semantics — that lives in
 * the components (`ui/components`) and the router.
 */
import { setState } from "../core/store.ts";
import type { Component } from "../ui/components/Component.ts";
import { ChatViewport } from "../ui/components/ChatViewport.ts";
import { InputComponent } from "../ui/components/InputComponent.ts";
import { StatusComponent } from "../ui/components/StatusComponent.ts";
import { DrawerComponent } from "../ui/components/DrawerComponent.ts";
import { GeneratingComponent } from "../ui/components/GeneratingComponent.ts";
import { ToastComponent } from "../ui/components/ToastComponent.ts";
import { registerDrawerChild } from "../ui/components/drawerRegistry.ts";
import {
  composeMainPane,
  createScheduler,
  resetFrameCache,
  runPipeline,
  writeFrame,
  type Scheduler,
} from "../ui/pipeline/index.ts";
import { getTopLevel, routeChar, routeKey, type Globals } from "../ui/components/keyRouter.ts";
import { createInputDecoder } from "../ui/components/inputDecode.ts";
import { emitDebug, isKeyLogEnabled, keyLogPath, setKeyDumpSink } from "../ui/debugLog.ts";
import type { CopyRequest } from "../core/copyText.ts";
import { wireCopySinks } from "./copySinks.ts";
import { termCols } from "./transcriptRebuild.ts";

/** The submit/abort/output hooks the globals need (wired by main). */
export interface AppHooks {
  submit(): void;
  abortTurn(): void;
  quit(code: number): void;
  /** Persist the last session id (composition root owns state.json). */
  saveState(lastSessionId: string | null): Promise<void>;
  /** The `out/` file sink (the filesystem is composition-root-only). */
  outputToFile(request: CopyRequest): void;
}

/**
 * The key-logger hex-dump sink decision (no fs here — the composition
 * root supplies the writer): undefined when the logger is off or
 * chunk-only; a consuming wrapper when `YOG_DEBUG_KEYS` names a file.
 */
export function keyDumpSink(): ((raw: string) => void) | undefined {
  if (!isKeyLogEnabled()) return undefined;
  const keyEnv = keyLogPath();
  if (keyEnv === undefined || keyEnv === "1") return undefined;
  return (raw: string) => emitKeyDump(keyEnv, raw);
}

/** The hex-dump writer hook (wired by the composition root). */
let dumpWriter: ((path: string, raw: string) => void) | undefined;

/** Wire the hex-dump writer (composition root; owns node:fs). */
export function setKeyDumpWriter(writer: (path: string, raw: string) => void): void {
  dumpWriter = writer;
}

function emitKeyDump(path: string, raw: string): void {
  dumpWriter?.(path, raw);
}

/** The assembled terminal: components, scheduler, globals, key decoder. */
export interface Terminal {
  viewport: ChatViewport;
  input: InputComponent;
  chain: readonly Component[];
  scheduler: Scheduler;
  globals: Globals;
  /** The raw-input handler for `stdin.on("data")`. */
  handleData(chunk: string): void;
  /** Draw one frame now (also the resize hook). */
  draw(): void;
  /** Forget the diff baseline (a resize made the old frame meaningless). */
  resetFrame(): void;
  stopSpinner(): void;
}

/** Assemble the component chain, the draw loop, and the key surface. */
export function wireTerminal(client: { sessionId: string | undefined }, hooks: AppHooks): Terminal {
  const viewport = new ChatViewport();
  const input = new InputComponent();
  const status = new StatusComponent();
  const drawer = new DrawerComponent();
  const generating = new GeneratingComponent();
  const toast = new ToastComponent();
  registerDrawerChild(generating);
  registerDrawerChild(toast);
  const spinner = spinnerHooks(generating);
  // Top-level focus ring: the log and the input are the two ring targets.
  viewport.ring = "log";
  input.ring = "input";
  const chain: readonly Component[] = [viewport, input, drawer, status];

  /** Rows the composition consumes from the viewport for the log gap: the
   *  drawer's top padding is that gap when the drawer is visible (one row),
   *  and the composition's own blank row is the gap when it is collapsed
   *  (zero — the blank reuses or replaces a viewport row in place). */
  const drawerGap = (cols: number): number => (drawer.measure(cols) > 0 ? 1 : 0);

  /** Rows available to the log viewport in the current terminal layout. */
  const viewportRows = (): number =>
    Math.max(
      1,
      (process.stdout.rows ?? 24) -
        input.measure(termCols()) -
        drawer.measure(termCols()) -
        status.measure(termCols()) +
        drawerGap(termCols()),
    );

  /** Run one frame through the staged render pipeline. */
  const draw = (): void => {
    const cols = termCols();
    runPipeline({
      width: cols,
      setMetrics: () => {
        // The log gets the remainder after the input bar (which grows by
        // one row when the slash-command autocomplete menu is open), the
        // drawer (zero rows when fully collapsed), and the status line —
        // plus the row the composition consumes for the log gap when the
        // drawer is visible (its top padding is that gap).
        viewport.setViewportRows(viewportRows());
      },
      paint: () =>
        composeMainPane(
          viewport.render({ cols }),
          drawer.render({ cols }),
          input.render({ cols }),
          status.render({ cols }),
        ),
      emit: writeFrame,
    });
  };

  // Single wiring point: every setState notifies this store subscriber,
  // which coalesces redraws with the FRAME_MS timer and runs the pipeline
  // on flush.
  const scheduler = createScheduler(draw);

  viewport.copyActions = wireCopySinks(toast, () => client.sessionId, hooks.outputToFile);

  const globals: Globals = {
    quit: () => hooks.quit(0),
    focusNext: () => viewport.cycleFocus(1),
    focusPrev: () => viewport.cycleFocus(-1),
    scrollBy: (delta) => viewport.scrollBy(delta, viewportRows()),
    jump: (top) => viewport.jump(top, viewportRows()),
    submit: hooks.submit,
    abortTurn: hooks.abortTurn,
    pageRows: () => process.stdout.rows ?? 24,
  };

  return {
    viewport,
    input,
    chain,
    scheduler,
    globals,
    handleData: keyHandler(chain, globals, keyDumpSink()),
    draw,
    resetFrame: resetFrameCache,
    stopSpinner: spinner.stop,
  };
}

/** The busy-spinner pair: the generating component's timer and the store's
 *  `busy` flag are flipped together (the composition root owns both). */
function spinnerHooks(generating: GeneratingComponent): {
  start(): void;
  stop(): void;
} {
  return {
    start: (): void => {
      setState({ busy: true });
      generating.start();
    },
    stop: (): void => {
      setState({ busy: false });
      generating.stop();
    },
  };
}

/**
 * Key logger: `YOG_DEBUG_KEYS=1` adds the key/char/paste diagnostics to the
 * debug chunk stream; a path (`YOG_DEBUG_KEYS=/some/file`) does that AND
 * appends a hex dump of every raw input chunk to the file. Both are gated
 * on `YOG_DEBUG=1` (debug chunks) — `YOG_DEBUG_KEYS` alone stays inert.
 */
function keyHandler(
  chain: readonly Component[],
  globals: Globals,
  keyDump: ((raw: string) => void) | undefined,
): (chunk: string) => void {
  const keyLoggerOn = isKeyLogEnabled();
  setKeyDumpSink(keyDump);
  /** Raw-input decoder (sequences, chars, bracketed paste framing). */
  const decodeInput = createInputDecoder({
    onSequence: (seq) => {
      const code = Buffer.from(seq, "utf8").toString("hex");
      if (keyLoggerOn) emitDebug([`key ${code}`], seq);
      const routed = routeKey(chain, seq, globals);
      if (keyLoggerOn)
        emitDebug([`key ${code} ${routed ? "handled" : "unhandled"} ring=${getTopLevel()}`]);
    },
    onChar: (ch) => {
      const code = Buffer.from(ch, "utf8").toString("hex");
      if (keyLoggerOn) emitDebug([`char ${code}`], ch);
      const routed = routeChar(chain, ch, globals);
      if (keyLoggerOn)
        emitDebug([`char ${code} ${routed ? "handled" : "unhandled"} ring=${getTopLevel()}`]);
    },
    onPasteEnd: (content) => {
      if (keyLoggerOn) emitDebug([`paste ${Buffer.byteLength(content, "utf8")} bytes`], content);
      // The paste content is inserted verbatim by the input component.
      inputPaste(chain, content);
    },
  });
  return (chunk: string): void => {
    decodeInput(chunk);
  };
}

/** Deliver pasted text to the input component (the chain's ring side). */
function inputPaste(chain: readonly Component[], content: string): void {
  for (const component of chain) {
    if (component instanceof InputComponent) {
      component.paste(content);
      return;
    }
  }
}
