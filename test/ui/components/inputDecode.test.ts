import { describe, expect, it } from "vitest";

import {
  createInputDecoder,
  matchSequence,
  PASTE_END,
  PASTE_START,
  type InputHandlers,
} from "../../../src/ui/components/inputDecode.ts";

function harness() {
  const events: string[] = [];
  const handlers: InputHandlers = {
    onSequence: (seq) => events.push(`seq:${seq}`),
    onChar: (ch) => events.push(`char:${ch}`),
    onPasteEnd: (content) => events.push(`paste:${content}`),
  };
  return { events, handlers };
}

describe("matchSequence", () => {
  it("parses CSI sequences with parameter bytes", () => {
    expect(matchSequence("\x1b[13;2u")).toBe("\x1b[13;2u");
    expect(matchSequence("\x1b[A")).toBe("\x1b[A");
    expect(matchSequence("\x1b[27;2;13~")).toBe("\x1b[27;2;13~");
    expect(matchSequence("\x1b[200~")).toBe("\x1b[200~");
  });

  it("returns null for plain input and incomplete escapes", () => {
    expect(matchSequence("a")).toBeNull();
    expect(matchSequence("\x1b")).toBeNull();
    expect(matchSequence("\x1b[")).toBeNull();
    expect(matchSequence("\x1b[13;2")).toBeNull(); // incomplete
    expect(matchSequence("\x1bX")).toBeNull(); // not CSI/SS3
  });
});

describe("createInputDecoder", () => {
  it("forwards sequences and characters", () => {
    const { events, handlers } = harness();
    const decode = createInputDecoder(handlers);
    decode("ab");
    decode("\x1b[13;2u");
    expect(events).toEqual(["char:a", "char:b", "seq:\x1b[13;2u"]);
  });

  it("buffers bracketed paste and delivers it as one event", () => {
    const { events, handlers } = harness();
    const decode = createInputDecoder(handlers);
    decode(`${PASTE_START}hello\nworld${PASTE_END}`);
    expect(events).toEqual(["paste:hello\nworld"]);
  });

  it("reassembles a paste split across chunks", () => {
    const { events, handlers } = harness();
    const decode = createInputDecoder(handlers);
    decode(`${PASTE_START}hel`);
    decode("lo\n");
    decode(`wor${PASTE_END}`);
    expect(events).toEqual(["paste:hello\nwor"]);
  });

  it("keeps control characters inside a paste literal (never routed)", () => {
    const { events, handlers } = harness();
    const decode = createInputDecoder(handlers);
    decode(`${PASTE_START}a\r\nb${PASTE_END}`);
    expect(events).toEqual(["paste:a\r\nb"]);
  });

  it("does not treat paste markers as chars outside paste mode", () => {
    const { events, handlers } = harness();
    const decode = createInputDecoder(handlers);
    decode(PASTE_START);
    decode("x");
    decode(PASTE_END);
    expect(events).toEqual(["paste:x"]);
  });
});
