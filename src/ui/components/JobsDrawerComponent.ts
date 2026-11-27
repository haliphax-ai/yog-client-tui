/**
 * Background-jobs drawer view (yog#92 client track): a live table of the
 * session's detached jobs. Event-fed (yog#100): the server pushes
 * `job.started`/`job.settled` on the session stream — the drawer patches
 * its rows off those and computes runtime from startedAt (stamped with
 * the real duration at settle). One one-shot `jobs.get` fetch runs when
 * the view opens (and on resume) to seed current status; there is no
 * polling loop against an open SSE connection.
 *
 * Capabilities-gated (the master issue's hard rule): the component renders
 * NOTHING — zero rows, like an unregistered child — until the server
 * advertises the `background-jobs` feature AND the view is toggled open.
 * Gating on the feature alone is not enough: the drawer holds registered
 * children in one padded block, so an open-but-unavailable view must
 * never spend a frame row (a server without the subsystem keeps the
 * drawer fully collapsed).
 *
 * Rows are plain text (fixed id / tool / state / elapsed / exit columns),
 * cell-truncated per row — widths in CELLS, never characters (AGENTS.md).
 */
import { BaseComponent, type RenderContext } from "./Component.ts";
import type { DrawerCommand, DrawerCommandProvider, DrawerDismissable } from "./drawerRegistry.ts";
import { getState, setState } from "../../core/index.ts";
import { formatDuration } from "../../core/index.ts";
import {
  parseTable,
  renderTable,
  resolveTableLayout,
  type ParsedTable,
} from "../render/table/index.ts";
import { ST } from "../theme.ts";

/** The poll cadence (ms) while the view is open — the issue's ~2s. */
export const JOBS_POLL_MS = 2000;

/** The server feature the view gates on. */
export const BACKGROUND_JOBS_FEATURE = "background-jobs";

/** The announcement seam: the drawer reports one transition as
 *  `(state, detail)` — `detail` already carries the id and reason — and
 *  the composition root shapes the notice lines (it owns the log). */
export type JobAnnouncer = (state: string, detail: string) => void;
/** Apply a `job.started` payload to the row list (in place): patch the
 *  known row or append a fresh running row. */
function applyStarted(
  rows: JobRowInput[],
  idx: number,
  id: string,
  data: Record<string, unknown>,
): void {
  const startedAt = typeof data["startedAt"] === "number" ? data["startedAt"] : Date.now();
  const row: JobRowInput = {
    id,
    tool: typeof data["tool"] === "string" ? data["tool"] : "tool",
    startedAt,
    state: "running",
  };
  if (idx === -1) rows.push(row);
  else rows[idx] = { ...rows[idx]!, ...row };
}

/** Apply a `job.settled` payload to the row list (in place): the settled
 *  row (never called for an unknown job — the caller skips those). */
function applySettled(
  rows: JobRowInput[],
  idx: number,
  data: Record<string, unknown>,
): JobRowInput {
  const state = typeof data["state"] === "string" ? data["state"] : "finished";
  const endedAt = typeof data["endedAt"] === "number" ? data["endedAt"] : undefined;
  const settled: JobRowInput = {
    ...rows[idx]!,
    state,
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(typeof data["reason"] === "string" ? { termReason: data["reason"] } : {}),
    ...("result" in data ? { result: data["result"] } : {}),
  };
  rows[idx] = settled;
  return settled;
}

/** One job's id, its last lifecycle state, and why (terminated only) —
 *  the identity a transition notice keys on. */
interface JobFingerprint {
  readonly id: string;
  readonly state: string;
  readonly termReason?: string;
}

/** The fingerprint of one wire row (the transition diff's baseline). */
function fingerprintOf(job: JobRowInput): JobFingerprint {
  return {
    id: job.id,
    state: job.state,
    ...(job.termReason !== undefined ? { termReason: job.termReason } : {}),
  };
}

/** Column headers (fixed five-column layout). */
const HEADERS = ["id", "tool", "state", "elapsed", "exit"] as const;

/** The state stamp on a row: state + why, terminated only. */
function stateCell(state: string, termReason: string | undefined): string {
  return state === "terminated" ? `terminated(${termReason ?? "?"})` : state;
}

/** The wall-clock time a job has been alive (start → settle or now). */
function elapsedCell(startedAt: number, endedAt: number | undefined, now: number): string {
  const end = endedAt ?? now;
  return formatDuration(Math.max(0, end - startedAt), true);
}

/** The job's exit stamp: the result's exit code when it carried one. */
function exitCell(result: unknown): string {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return "-";
  const exit = (result as Record<string, unknown>)["exitCode"];
  return typeof exit === "number" ? `exit ${exit}` : "-";
}

/** The wire shape the component accepts (the client's BackgroundJob row). */
export interface JobRowInput {
  readonly id: string;
  readonly sessionId?: string;
  readonly tool: string;
  readonly argsJson?: string | null;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly state: string;
  readonly result?: unknown;
  readonly pid?: number;
  readonly termReason?: string;
}

/** The drawer's display slice: most recent first, capped. */
export const JOBS_MAX_ROWS = 5;

/** The rows the drawer shows: the freshest JOBS_MAX_ROWS jobs in reverse
 *  start order (newest row on top). Server order is start-ascending. */
export function visibleJobs(jobs: readonly JobRowInput[]): readonly JobRowInput[] {
  return [...jobs].sort((a, b) => b.startedAt - a.startedAt).slice(0, JOBS_MAX_ROWS);
}

/** Build the drawer's table: GFM text through the shared parser (the
 *  engine's GFM normalization rectifies ragged rows), columns fixed to
 *  the header shape. */
export function jobsTable(headers: readonly string[], rows: readonly string[][]): ParsedTable {
  const line = (cells: readonly string[]): string => "| " + cells.join(" | ") + " |";
  const rule = "| " + headers.map(() => "---").join(" | ") + " |";
  const text = [line(headers), rule, ...rows.map(line)].join("\n");
  const parsed = parseTable(text);
  return (
    parsed ?? {
      columns: headers.map((title) => ({ title, width: 3, align: "left" as const })),
      rows: rows.map((r) => [...r]),
    }
  );
}

/** Shape one wire row into the table cells (widths unfilled). */
export function jobRowCells(job: JobRowInput, now: number): string[] {
  return [
    job.id,
    job.tool,
    stateCell(job.state, job.termReason),
    elapsedCell(job.startedAt, job.endedAt, now),
    exitCell(job.result),
  ];
}

/**
 * The component: renders the job table while open AND gated-in, nothing
 * otherwise. The composition root supplies the fetch + the gate; the
 * component owns drawing, the open flag, and the poll timer (armed while
 * open — the same flag-driven ticking pattern as the busy spinner).
 */
export class JobsDrawerComponent
  extends BaseComponent
  implements DrawerDismissable, DrawerCommandProvider
{
  /** The fetcher: resolves the session's job rows (the client's getJobs). */
  private fetcher: (() => Promise<JobRowInput[]>) | undefined;
  /** The gate: true when the server advertises `background-jobs`. */
  private gate: () => boolean = () => false;
  private inFlight = false;
  /** The fingerprints the last poll rendered (the transition diff reads
   *  against these). Undefined = the first poll after wiring (nothing
   *  has been shown yet — arrivals announce only when newly visible). */
  private fingerprints: readonly JobFingerprint[] | undefined = undefined;
  /** The log announcer (the composition root pushes the notice lines). */
  private announce: JobAnnouncer | undefined = undefined;
  /** The job rows the drawer currently knows (event-fed + fetch-fed). */
  private jobInputs: readonly JobRowInput[] | undefined = undefined;

  constructor() {
    super(false);
  }

  /** Wire the fetch + gate + announcer (the composition root, once, after
   *  probe). `announce` is optional (undefined skips transition notices
   *  — existing wire calls and tests keep working). */
  wire(fetcher: () => Promise<JobRowInput[]>, gate: () => boolean, announce?: JobAnnouncer): void {
    this.fetcher = fetcher;
    this.gate = gate;
    this.announce = announce;
  }

  /**
   * Ingest one server-pushed job event (job.started / job.settled on the
   * session stream): patch the row set incrementally instead of polling.
   * The server owns the lifecycle — the drawer computes elapsed from
   * startedAt live and stamps the real duration when a settled event
   * arrives. Unknown-event shapes are ignored (old servers never send
   * these). Returns whether the event was recognized.
   */
  onJobEvent(type: string, data: Record<string, unknown>): boolean {
    if (type !== "job.started" && type !== "job.settled") return false;
    const id = typeof data["id"] === "string" ? data["id"] : undefined;
    if (id === undefined) return false;
    const rows = [...(this.jobInputs ?? [])];
    const idx = rows.findIndex((j) => j.id === id);
    if (type === "job.started") {
      applyStarted(rows, idx, id, data);
    } else if (idx !== -1) {
      const settled = applySettled(rows, idx, data);
      this.announceTransition(settled);
    }
    this.jobInputs = rows;
    this.fingerprints = rows.map(fingerprintOf);
    this.renderRows(rows);
    return true;
  }

  /**
   * Toggle the view (`/jobs`): on → open + poll; off → closed. Returns
   * whether the view is AVAILABLE (gated in) — the drawer command uses
   * the return to decide between toggling and the unavailable note. A
   * gated-out toggle flips nothing (the view renders nothing either way)
   * so the store never carries an open flag the drawer cannot honor.
   */
  toggle(): boolean {
    if (!this.gate()) return false;
    const open = !(getState().jobsOpen === true);
    setState({ jobsOpen: open });
    if (open) void this.poll();
    return true;
  }

  /** The Esc cascade's drawer arm: close the open view; false when shut. */
  dismiss(): boolean {
    if (getState().jobsOpen !== true) return false;
    setState({ jobsOpen: false });
    return true;
  }

  /** The `/jobs` drawer command (client-local). `run` returns false when
   *  ungated; the slash dispatcher shows the unavailable note. */
  drawerCommands(): readonly DrawerCommand[] {
    return [
      {
        command: { name: "jobs", summary: "toggle the background-jobs drawer" },
        run: () => this.toggle(),
      },
    ];
  }

  /** One poll tick: fetch, diff against the rendered fingerprints for
   *  transition notices, reshape, store; timer re-arms in render().
   *  Announcements are notice lines on the shared log (`pushLines`),
   *  injected like the fetcher — the component stays drawer-local and
   *  the composition root keeps the log. */
  async poll(): Promise<void> {
    if (this.inFlight || this.fetcher === undefined) return;
    this.inFlight = true;
    try {
      const jobs = await this.fetcher();
      this.announceTransitions(jobs);
      // The poll snapshot BECOMES the event-fed baseline (the one-shot
      // status fetch the resume path runs; no 2s re-fetch against an
      // open stream).
      this.jobInputs = jobs;
      this.fingerprints = jobs.map(fingerprintOf);
      this.renderRows(jobs);
    } catch {
      // Best effort: keep the previous rows, retry on the next tick.
    } finally {
      this.inFlight = false;
    }
  }

  /** The lifecycle transitions the fresh poll reveals against the last
   *  rendered snapshot: a job settling to `terminated` or `finished`
   *  between ticks announces once (the state cell already shows it; the
   *  notice is the log-side signal that survives closing the view).
   *  Settled jobs that were never rendered announce nothing — there is
   *  no baseline to have "watched" them run (a fresh view shows the
   *  settled state directly). A missing announce callback skips
   *  silently (the wire may not be called in tests). */
  private announceTransitions(jobs: readonly JobRowInput[]): void {
    if (this.announce === undefined || this.fingerprints === undefined) return;
    for (const job of jobs) {
      if (job.state !== "terminated" && job.state !== "finished") continue;
      const was = this.fingerprints.find((f) => f.id === job.id);
      if (was === undefined || was.state === job.state) continue;
      const reason = job.state === "terminated" ? ` (${job.termReason ?? "terminated"})` : "";
      this.announce(job.state, `${job.id}${reason}`);
    }
  }

  /** One job's transition notice (the onJobEvent settle path). */
  private announceTransition(job: JobRowInput): void {
    if (this.announce === undefined) return;
    if (job.state !== "terminated" && job.state !== "finished") return;
    const reason = job.state === "terminated" ? ` (${job.termReason ?? "terminated"})` : "";
    this.announce(job.state, `${job.id}${reason}`);
  }

  /** Rebuild the visible rows from the input list (event-fed updates). */
  private renderRows(jobs: readonly JobRowInput[]): void {
    const shown = visibleJobs(jobs);
    setState({ jobRows: shown.map((job) => jobRowCells(job, Date.now())) });
  }

  /**
   * The rows: nothing when closed or gated out; the styled table (header
   * + one row per job, or the empty note) when open. The timer follows
   * the open flag here — armed while open, disarmed when closed (the
   * GeneratingComponent's flag-driven ticking pattern).
   */
  override render(ctx: RenderContext): string[] {
    if (getState().jobsOpen !== true || !this.gate()) {
      return [];
    }
    // No timer: the drawer is event-fed (job.started / job.settled on the
    // session stream) plus this open-time one-shot status fetch.
    void this.poll();
    const rows: string[][] = (getState().jobRows ?? []).map((cells) => [...cells]);
    const head = ST.system.render("⏳ background jobs");
    if (rows.length === 0) return [head, ST.system.render("(no background jobs)")];
    // The shared table engine (the chat log's model-table renderer): box
    // borders, bold header, zebra rows — and its layout solver for
    // overflow (shrinkwrap → divide → expand), which the hand-rolled
    // shrinkwrap had none of. The drawer renders unfocused.
    const table = jobsTable([...HEADERS], rows);
    const layout = resolveTableLayout(
      table.columns.map((c) => c.width),
      Math.max(0, ctx.cols - 2),
      false,
    );
    return [head, ...renderTable(table, ctx.cols - 2, { widths: layout.widths })];
  }
}

/** The header cells are part of the shaping surface (tests assert them). */
export const JOBS_HEADERS = HEADERS;
