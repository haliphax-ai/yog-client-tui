/**
 * The transport plumbing the yog client sits on: the base origin, the
 * auth headers, and the fetch policies (a transport failure surfaces as
 * reachability guidance or a plain Error; non-2xx as a `YogError` named
 * by the failed call). One place so every route shares the error rules.
 */
import { randomUUID } from "node:crypto";
import {
  authHeaders,
  buildEnvelope,
  isUnreachable,
  toError,
  toYogError,
  unreachableError,
} from "../yogClient.ts";
import type { MessageResponse, MessageType } from "../yogClient.ts";

/** The connection plumbing every route shares. */
export abstract class Transport {
  /** Server origin, trailing slashes stripped. */
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  /** Auth headers for every request (bearer token when configured). */
  protected headers(extra?: Record<string, string>): Record<string, string> {
    return { ...authHeaders(), ...extra };
  }

  /** One raw fetch with the shared error policy: a transport failure
   *  surfaces as reachability guidance or a plain Error; non-2xx as a
   *  `YogError` (`what` names the failed call). */
  protected async fetchRaw(path: string, init: RequestInit, what: string): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, init);
    } catch (err) {
      throw isUnreachable(err) ? unreachableError(this.baseUrl, err) : toError(err);
    }
    if (!res.ok) throw await toYogError(res, what);
    return res;
  }

  /** The long-lived stream's initial fetch: failures settle `closed` with
   *  the error instead of throwing (the turn loop reads the outcome off
   *  the promise). `undefined` = the stream never opened. */
  protected async fetchStream(
    sessionId: string,
    controller: AbortController,
    settle: (err: Error | undefined) => void,
  ): Promise<Response | undefined> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/sessions/${sessionId}/stream`, {
        headers: this.headers(),
        signal: controller.signal,
      });
    } catch (err) {
      settle(isUnreachable(err) ? unreachableError(this.baseUrl, err) : toError(err));
      return undefined;
    }
    if (!res.ok) {
      settle(await toYogError(res, "opening session stream failed"));
      return undefined;
    }
    return res;
  }
  /**
   * One typed message on the messages channel. Generates a `requestId`
   * (correlation + idempotent-retry handle) unless the caller supplies one,
   * and unwraps the `{ type, version, requestId?, data }` response to its
   * `data`. Non-2xx surfaces as a `YogError` (`unknown_session` included).
   */
  protected async send(
    sessionId: string,
    type: MessageType | (string & {}),
    data: Record<string, unknown> = {},
    what = `${type} failed`,
  ): Promise<Record<string, unknown>> {
    const requestId = randomUUID();
    const res = await this.fetchRaw(
      `/v1/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify(buildEnvelope(type, data, requestId)),
      },
      what,
    );
    const body = (await res.json()) as MessageResponse;
    return body.data ?? {};
  }
}
