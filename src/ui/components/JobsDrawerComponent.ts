/**
 * Background-jobs drawer view (yog#92 client track): a live table of the
 * session's detached jobs, polled from `jobs.get` while visible.
 *
 * Capabilities-gated (the master issue's hard rule): the component renders
 * NOTHING — zero rows, like an unregistered child — until the server
 * advertises the `background-jobs` feature AND the view is toggled open.
 * Gating on the feature alone is not enough: the drawer holds registered
 * children in one padded block, so an open-but-unavailable view must
 * never spend a frame row (a server without the subsystem keeps the
 * drawer fully collapsed).
 *
 * The poll is best-effort: a failed probe keeps the last rows and retries
 * on the next tick (the same policy the running-turn poll follows). Rows
 * are plain text (fixed id / tool / state / elapsed / exit columns),
 * cell-truncated per row — widths in CELLS, never characters (AGENTS.md).
 */
import { BaseComponent, type RenderContext } from "./Component.ts";
import type { DrawerCommand, DrawerCommandProvider, DrawerDismissable } from "./drawerRegistry.ts";
import { getState, setState } from "../../core/index.ts";
import { formatDuration } from "../../core/index.ts";
import { displayWidth } from "../../util/index.ts";
import { ST } from "../theme.ts";

/** The poll cadence (ms) while the view is open — the issue's ~2s. */
export const JOBS_POLL_MS = 2000;

/** The server feature the view gates on. */
export const BACKGROUND_JOBS_FEATURE = "background-jobs";

/** The announcement seam: the drawer reports one transition as
 *  `(state, detail)` — `detail` already carries the id and reason — and
 *  the composition root shapes the notice lines (it owns the log). */
export type JobAnnouncer = (state: string, detail: string) => void;

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

/** Shape one wire row into the table's cells (widths unfilled). */
export function jobRowCells(job: JobRowInput, now: number): string[] {
  return [
    job.id,
    job.tool,
    stateCell(job.state, job.termReason),
    elapsedCell(job.startedAt, job.endedAt, now),
    exitCell(job.result),
  ];
}

/** Column widths for a set of rows: the widest cell per column (min 3). */
export function jobColumnWidths(rows: readonly string[][]): number[] {
  const widths = HEADERS.map((h) => displayWidth(h));
  for (const cells of rows) {
    for (let i = 0; i < widths.length; i++) {
      const cell = cells[i];
      if (cell === undefined) continue;
      widths[i] = Math.max(widths[i] ?? 3, displayWidth(cell));
    }
  }
  return widths;
}

/** One row rendered to a padded line: cells left-justified to the widths. */
function rowLine(cells: readonly string[], widths: readonly number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < widths.length; i++) {
    const cell = cells[i] ?? "";
    const pad = Math.max(0, (widths[i] ?? 0) - displayWidth(cell));
    parts.push(cell + " ".repeat(pad));
  }
  return parts.join("  ").trimEnd();
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
  private timer: NodeJS.Timeout | undefined;
  private inFlight = false;
  /** The fingerprints the last poll rendered (the transition diff reads
   *  against these). Undefined = the first poll after wiring (nothing
   *  has been shown yet — arrivals announce only when newly visible). */
  private fingerprints: readonly JobFingerprint[] | undefined = undefined;
  /** The log announcer (the composition root pushes the notice lines). */
  private announce: JobAnnouncer | undefined = undefined;

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
      this.fingerprints = jobs.map(fingerprintOf);
      setState({
        jobRows: jobs.map((job) => jobRowCells(job, Date.now())),
      });
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

  private stopTicking(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private startTicking(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.poll(), JOBS_POLL_MS);
    this.timer.unref?.();
  }

  /**
   * The rows: nothing when closed or gated out; the styled table (header
   * + one row per job, or the empty note) when open. The timer follows
   * the open flag here — armed while open, disarmed when closed (the
   * GeneratingComponent's flag-driven ticking pattern).
   */
  override render(_ctx: RenderContext): string[] {
    if (getState().jobsOpen !== true || !this.gate()) {
      this.stopTicking();
      return [];
    }
    this.startTicking();
    const rows: string[][] = (getState().jobRows ?? []).map((cells) => [...cells]);
    const widths = jobColumnWidths(rows);
    const body =
      rows.length === 0
        ? [ST.system.render("(no background jobs)")]
        : [
            ST.system.render(rowLine([...HEADERS], widths)),
            ...rows.map((cells) => ST.system.render(rowLine(cells, widths))),
          ];
    return [ST.system.render("⏳ background jobs"), ...body];
  }
}

/** The header cells are part of the shaping surface (tests assert them). */
export const JOBS_HEADERS = HEADERS;
