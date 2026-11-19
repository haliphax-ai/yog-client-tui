/**
 * Transcript-dump row decoding for the transport: the per-turn metrics
 * rows and the session block of a `transcript.get` reply, tolerated
 * shapes only — old servers and odd payloads degrade gracefully instead
 * of failing the dump.
 */
import type { TokenUsage } from "./wire.ts";
import { parseUsage } from "./decode.ts";

/** The `session` block of a transcript dump (absent on odd payloads). */
export function sessionOf(
  body: { session?: { id?: unknown; status?: unknown } },
  fallback: string,
): string {
  const id = body.session?.id;
  return typeof id === "string" ? id : fallback;
}

/** The session settle status (`open` when the dump carries none). */
export function statusOf(body: { session?: { id?: unknown; status?: unknown } }): string {
  const status = body.session?.status;
  return typeof status === "string" ? status : "open";
}

/** One decoded per-turn metrics row (the wire shape, tolerated). */
export interface TurnRow {
  turnId: number;
  status?: string;
  usage?: TokenUsage;
  durationMs?: number;
}

/** A turn row's numeric id, or undefined (the row is unusable without one). */
function rowTurnId(rec: Record<string, unknown>): number | undefined {
  return typeof rec["turnId"] === "number" ? rec["turnId"] : undefined;
}

/** A turn row's duration (finite numbers only). */
function rowDuration(rec: Record<string, unknown>): number | undefined {
  const v = rec["durationMs"];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** A turn row's settle status (non-empty strings only). */
function rowStatus(rec: Record<string, unknown>): string | undefined {
  const v = rec["status"];
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** Decode one per-turn metrics row, or undefined when malformed. */
function decodeTurnRow(t: unknown): TurnRow | undefined {
  if (t === null || typeof t !== "object" || Array.isArray(t)) return undefined;
  const rec = t as Record<string, unknown>;
  const turnId = rowTurnId(rec);
  if (turnId === undefined) return undefined;
  const usage = parseUsage(rec["usage"]);
  const durationMs = rowDuration(rec);
  const status = rowStatus(rec);
  return {
    turnId,
    ...(status !== undefined ? { status } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

/**
 * The dump's per-turn metrics: additive and optional; absent/malformed
 * entries degrade gracefully so old servers and odd payloads still load.
 * A row is kept when it has metrics OR a settle status — the status alone
 * is meaningful (`running` = an active turn the reconnecting client
 * should surface, even with no usage/duration yet).
 */
export function transcriptTurns(raw: unknown): TurnRow[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(decodeTurnRow)
    .filter(
      (t: TurnRow | undefined): t is TurnRow =>
        t !== undefined &&
        (t.usage !== undefined || t.durationMs !== undefined || t.status !== undefined),
    );
}
