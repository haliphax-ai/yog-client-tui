/**
 * The idle-watch stream re-arm (#144): a dead watch stream used to strand
 * foreign-turn rendering for the session's remaining life — nothing
 * re-armed it except the next submit. The behaviors pinned here: a
 * `closed` stream re-arms with a growing backoff; a dropped session
 * (unknown_session) stops the retrying; disarm cancels a pending retry.
 *
 * The stub only keeps the FIRST `closes` streams open, so a later open
 * closing again is expected — the assertions count opens inside a
 * window, and the unknown_session case must hold at exactly one open.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { startIdleWatch } from "../../src/app/index.ts";
import type { YogClient } from "../../src/client/index.ts";
import { YogError } from "../../src/client/index.ts";
import { resetForTests, setState } from "../../src/core/index.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetForTests();
});

/** A YogClient-shaped stub whose openStream ends after `n` opens with
 *  `err` (resolved on the stream's `closed`), recording each open. */
/** The stub only keeps the FIRST `opens` streams open; later opens close
 *  too — so "never re-armed" must assert on the open count, not assume
 *  the stream handle stops the retry chain. */
function stubClient(closes: number, err: Error | undefined, openLog: number[]): YogClient {
  return {
    sessionId: "s1",
    openStream(_sessionId: string, _onEvent: unknown) {
      openLog.push(openLog.length + 1);
      const closed = new Promise<Error | undefined>((resolve) => {
        if (openLog.length <= closes) setTimeout(() => resolve(err), 1);
        // Never resolves afterwards: the open stream stays open.
      });
      return { streamId: "st", closed, close: () => undefined };
    },
  } as unknown as YogClient;
}

function host() {
  return {
    entries: [] as Array<{ kind: string; lines: string[] }>,
    append: (kind: never, lines: never) => void (host as never),
    width: () => 80,
    requestRender: () => undefined,
    nextMessageSeq: () => "1",
  } as never;
}

describe("idleWatch stream re-arm", () => {
  it("re-arms with a growing backoff after the stream closes", async () => {
    vi.useFakeTimers();
    const openLog: number[] = [];
    const watch = startIdleWatch(stubClient(4, new Error("boom"), openLog), host());
    watch.arm();
    await vi.advanceTimersByTimeAsync(5);
    expect(openLog.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1000); // first backoff 1 s
    expect(openLog.length).toBe(2);
    await vi.advanceTimersByTimeAsync(2000); // then 2 s
    expect(openLog.length).toBe(3);
    await vi.advanceTimersByTimeAsync(4000); // then 4 s
    expect(openLog.length).toBe(4);
  });

  it("stops retrying when the server dropped the session (unknown_session)", async () => {
    vi.useFakeTimers();
    const openLog: number[] = [];
    const err = new YogError("unknown_session", "session s1 not found", 404);
    const watch = startIdleWatch(stubClient(1, err, openLog), host());
    watch.arm();
    await vi.advanceTimersByTimeAsync(5);
    expect(openLog.length).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(openLog.length).toBe(1); // never re-armed
  });

  it("disarm cancels a pending re-arm (the submit path owns the stream)", async () => {
    vi.useFakeTimers();
    const openLog: number[] = [];
    const watch = startIdleWatch(stubClient(2, new Error("boom"), openLog), host());
    watch.arm();
    await vi.advanceTimersByTimeAsync(5);
    expect(openLog.length).toBe(1);
    watch.disarm(); // cancel the pending backoff re-arm
    await vi.advanceTimersByTimeAsync(60_000);
    expect(openLog.length).toBe(1);
  });
});
