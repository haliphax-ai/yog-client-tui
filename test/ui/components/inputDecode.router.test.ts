import { beforeEach, describe, expect, it } from "vitest";

import { getState, resetForTests } from "../../../src/core/store.ts";
import { ChatViewport } from "../../../src/ui/components/ChatViewport.ts";
import { InputComponent } from "../../../src/ui/components/InputComponent.ts";
import { createInputDecoder } from "../../../src/ui/components/inputDecode.ts";
import { routeChar, routeKey, type Globals } from "../../../src/ui/components/keyRouter.ts";

/**
 * End-to-end input path test: raw bytes as a terminal would send them →
 * decoder → key router → InputComponent → store. This pins the behavior the
 * live client depends on (Shift+Enter encodings, paste framing, Enter submit).
 */
function wire() {
  resetForTests();
  const input = new InputComponent();
  const chain = [new ChatViewport(), input];
  const calls: string[] = [];
  const globals: Globals = {
    quit: () => calls.push("quit"),
    focusNext: () => calls.push("focusNext"),
    focusPrev: () => calls.push("focusPrev"),
    scrollBy: (delta) => calls.push(`scrollBy:${delta}`),
    jump: (top) => calls.push(`jump:${top}`),
    submit: () => calls.push("submit"),
    abortTurn: () => calls.push("abortTurn"),
    pageRows: () => 24,
  };
  const decode = createInputDecoder({
    onSequence: (seq) => routeKey(chain, seq, globals),
    onChar: (ch) => routeChar(chain, ch, globals),
    onPasteEnd: (content) => input.paste(content),
  });
  return { input, calls, decode };
}

describe("live input byte path", () => {
  beforeEach(() => resetForTests());

  it("typed characters land in the store", () => {
    const { decode, input } = wire();
    decode("hi");
    expect(input.handleChar("!")).toBe("handled");
    expect(getState().input).toBe("hi!");
  });

  it("Shift+Enter (CSI-u / Kitty) inserts a newline without submitting", () => {
    const { decode, calls } = wire();
    decode("hi");
    decode("\x1b[13;2u");
    expect(getState().input).toBe("hi\n");
    expect(calls).toEqual([]);
  });

  it("Shift+Enter (xterm modifyOtherKeys) inserts a newline without submitting", () => {
    const { decode, calls } = wire();
    decode("hi");
    decode("\x1b[27;2;13~");
    expect(getState().input).toBe("hi\n");
    expect(calls).toEqual([]);
  });

  it("plain Enter submits", () => {
    const { decode, calls } = wire();
    decode("hi");
    decode("\r");
    expect(calls).toEqual(["submit"]);
  });

  it("bracketed paste inserts multi-line text without submitting", () => {
    const { decode, calls } = wire();
    decode("\x1b[200~line1\nline2\x1b[201~");
    expect(getState().input).toBe("line1\nline2");
    expect(calls).toEqual([]);
  });

  it("a paste split across chunks is delivered intact", () => {
    const { decode, calls } = wire();
    decode("\x1b[200~hel");
    decode("lo\nwor");
    decode("ld\x1b[201~");
    expect(getState().input).toBe("hello\nworld");
    expect(calls).toEqual([]);
  });
});
