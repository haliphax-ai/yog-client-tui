/**
 * Transport error policy: the structured `YogError` decoded from a non-2xx
 * body, the bearer auth header, and the reachability rules a `fetch`
 * failure maps to.
 *
 * A separate module so the transport (`client/transport.ts`) can use it
 * without importing the client itself — the dependency graph stays
 * one-way (`client.ts` → the other `client/*` modules).
 */
/** Structured error decoded from a `{ error: { code, message } }` body. */
export class YogError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "YogError";
    this.code = code;
    this.status = status;
  }
}

/** Build the bearer header when `YOG_API_TOKEN` is set. */
export function authHeaders(): Record<string, string> | undefined {
  const token = process.env["YOG_API_TOKEN"];
  return token ? { authorization: `Bearer ${token}` } : undefined;
}

/** Decode a non-2xx JSON error envelope into a `YogError`. */
export async function toYogError(res: Response, what: string): Promise<Error> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    if (body?.error?.message) {
      return new YogError(body.error.code ?? "unknown", body.error.message, res.status);
    }
  } catch {
    /* non-JSON body; fall through to the status line */
  }
  return new YogError("http_error", `${what}: HTTP ${res.status}`, res.status);
}

/**
 * Walk a `fetch` failure chain looking for connection-establishment codes.
 * A server that dies *mid-session* (reset after connect) is not "never
 * started", so only ECONNREFUSED & friends count as unreachable.
 */
export function isUnreachable(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur !== undefined && cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const code = (cur as { code?: unknown }).code;
    if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** Friendly guidance when the daemon cannot be reached (it is never spawned). */
export function unreachableError(base: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `cannot reach yog server at ${base} (${detail}); ` +
      "start it first with `yog serve` (no server is spawned automatically) " +
      "and point the client's `baseUrl` at the running daemon",
  );
}

/** Coerce anything into an Error (fetch aborts may hand us non-Errors). */
export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
