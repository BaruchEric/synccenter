import type { Db } from "../db.ts";
import type { EventBus } from "./bus.ts";
import { listRunsForJobs, toView, type RunRow, type RunView } from "./runs-service.ts";
import {
  listWindowsForJobs,
  toWindowView,
  type WindowRow,
  type WindowView,
} from "./windows-service.ts";

/**
 * One unit of work the API drove, whatever its shape.
 *
 * `sync` is the Sync now chain: a window on each held member, then a bisync
 * to each cloud member once those windows close. `window` is one window on
 * its own (a scheduled one, or `?cloud=false`), `bisync` one bisync on its
 * own (Cloud only, or the trigger route). Every window and run row points at
 * its job, so the job is the one id that answers "what did that press do".
 */
export type JobKind = "sync" | "bisync" | "window";
/**
 * `done`: every leg finished clean. `stopped`: somebody closed a leg by
 * hand and nothing else went wrong. `failed`: no leg finished clean.
 * `partial`: some did, some did not — a window that hit its cap and then a
 * bisync that ran, say.
 */
export type JobState = "running" | "done" | "partial" | "failed" | "stopped";
export type JobSource = "api" | "cli" | "ui" | "mcp" | "schedule";

/** A row of the `jobs` table. `hosts`/`cloud`/`after` are JSON arrays. */
export interface JobRow {
  id: number;
  folder: string;
  kind: JobKind;
  via: "manual" | "schedule";
  started_at: string;
  finished_at: string | null;
  state: JobState;
  hosts: string;
  cloud: string;
  after: string;
  cloud_pending: number;
  opening: number;
  legs_failed: number;
  note: string | null;
  actor: string;
  source: JobSource;
}

/** What the legs add up to. Only what sums is summed. */
export interface JobTotals {
  /** Bytes the bisync legs moved, and what they were told the total was. */
  bytes: number;
  totalBytes: number;
  transfers: number;
  checks: number;
  listed: number;
  /** rclone errors plus Syncthing folder errors at the windows' close. */
  errors: number;
  /** What the windows still needed when they closed. */
  needFiles: number;
  needBytes: number;
  /** Wall clock of the whole job, to now while it runs. */
  seconds: number;
  /** Time the windows were open, and the bisyncs ran, summed per leg. */
  windowSeconds: number;
  runSeconds: number;
  /** The windows' caps summed, so cap use is windowSeconds / capSeconds. */
  capSeconds: number;
  legs: number;
  legsDone: number;
  legsRunning: number;
  /** Legs that failed, timed out, or never got a row. */
  legsFailed: number;
}

/** The wire shape: the row with its legs attached and the totals derived. */
export interface JobView {
  id: number;
  folder: string;
  kind: JobKind;
  via: "manual" | "schedule";
  started_at: string;
  finished_at: string | null;
  state: JobState;
  /** Syncthing members a window was planned on. */
  hosts: string[];
  /** rclone members a bisync was planned to. */
  cloud: string[];
  /** Window ids the cloud leg waits on — the job's own, or adopted ones. */
  after: number[];
  /** The cloud leg is queued behind `after` and has not started yet. */
  cloudPending: boolean;
  legsFailed: number;
  note: string | null;
  actor: string;
  source: JobSource;
  /** Oldest first: the order the legs ran in. */
  windows: WindowView[];
  runs: RunView[];
  totals: JobTotals;
}

export interface StartJobInput {
  folder: string;
  kind: JobKind;
  via: JobRow["via"];
  hosts: string[];
  cloud: string[];
  actor: string;
  source: JobSource;
  /** The engine's clock, so tests can drive time. Defaults to real now. */
  startedAt?: Date;
}

export function startJob(db: Db, input: StartJobInput): JobRow {
  const { lastInsertRowid } = db.run(
    `INSERT INTO jobs (folder, kind, via, started_at, state, hosts, cloud, actor, source)
     VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
    [
      input.folder,
      input.kind,
      input.via,
      (input.startedAt ?? new Date()).toISOString(),
      JSON.stringify(input.hosts),
      JSON.stringify(input.cloud),
      input.actor,
      input.source,
    ],
  );
  return getJob(db, Number(lastInsertRowid))!;
}

export function getJob(db: Db, id: number): JobRow | null {
  // bun:sqlite hands back untyped rows; the schema above is the contract.
  return (db.query("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | null) ?? null;
}

export interface ListJobsOpts {
  limit?: number;
  /** Only rows with an id below this one — the cursor for "load older". */
  before?: number;
  folder?: string;
  kind?: JobKind;
  state?: JobState;
}

export function listJobs(db: Db, opts: ListJobsOpts = {}): JobRow[] {
  const where: string[] = [];
  const params: Array<number | string> = [];
  if (opts.before !== undefined) {
    where.push("id < ?");
    params.push(opts.before);
  }
  if (opts.folder) {
    where.push("folder = ?");
    params.push(opts.folder);
  }
  if (opts.kind) {
    where.push("kind = ?");
    params.push(opts.kind);
  }
  if (opts.state) {
    where.push("state = ?");
    params.push(opts.state);
  }
  return db
    .query(`SELECT * FROM jobs${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
    .all(...params, opts.limit ?? 50) as JobRow[];
}

export function listActiveJobs(db: Db): JobRow[] {
  return db.query("SELECT * FROM jobs WHERE state = 'running' ORDER BY id ASC").all() as JobRow[];
}

/** The windows the cloud leg waits on. Replaces the list. */
export function setJobAfter(db: Db, id: number, after: number[]): void {
  db.run("UPDATE jobs SET after = ? WHERE id = ?", [JSON.stringify(after), id]);
}

export function setCloudPending(db: Db, id: number, pending: boolean): void {
  db.run("UPDATE jobs SET cloud_pending = ? WHERE id = ? AND state = 'running'", [pending ? 1 : 0, id]);
}

/**
 * Hold the job open while its legs are still being started. Opening a window
 * can also close it (a resume that fails closes the row from inside open), and
 * that close settles the job — while the loop is still about to open the next
 * host under the same id. Held, the job waits for the whole set.
 */
export function setJobOpening(db: Db, id: number, opening: boolean): void {
  db.run("UPDATE jobs SET opening = ? WHERE id = ? AND state = 'running'", [opening ? 1 : 0, id]);
}

/** Append to the job's note; notes join with a middle dot. */
export function noteJob(db: Db, id: number, note: string): void {
  db.run("UPDATE jobs SET note = CASE WHEN note IS NULL OR note = '' THEN ? ELSE note || ' · ' || ? END WHERE id = ?", [
    note,
    note,
    id,
  ]);
}

/** A leg that never got a row: a window that could not open, a bisync that did not start. */
export function failJobLeg(db: Db, id: number, note: string): void {
  db.run("UPDATE jobs SET legs_failed = legs_failed + 1 WHERE id = ?", [id]);
  noteJob(db, id, note);
}

/**
 * Recompute a running job from its legs and close it if nothing is pending.
 * Returns the row and whether it changed; null for an unknown id. Idempotent:
 * safe to call from every place a leg can end.
 */
export function settleJob(db: Db, id: number): { job: JobRow; changed: boolean } | null {
  const job = getJob(db, id);
  if (!job) return null;
  if (job.state !== "running") return { job, changed: false };
  if (job.cloud_pending === 1 || job.opening === 1) return { job, changed: false };

  const windows = listWindowsForJobs(db, [id], parseIds(job.after));
  const runs = listRunsForJobs(db, [id]);
  if (windows.some((w) => w.state === "running") || runs.some((r) => r.state === "running")) {
    return { job, changed: false };
  }

  const state = stateOf(windows, runs, job.legs_failed);
  const ends = [...windows, ...runs].map((l) => l.finished_at).filter((t): t is string => t !== null);
  const finishedAt = ends.length > 0 ? ends.sort()[ends.length - 1]! : new Date().toISOString();
  db.run("UPDATE jobs SET state = ?, finished_at = ? WHERE id = ? AND state = 'running'", [state, finishedAt, id]);
  return { job: getJob(db, id)!, changed: true };
}

/**
 * Settle every running job a window counts as a leg of: the job that opened
 * it, and any job that adopted it. A press onto an already-open window rides
 * a row it does not own and records it in `after`, so going by the window's
 * own `job_id` would leave the adopter running until the next boot.
 */
export function settleWindowJobs(db: Db, bus: EventBus, windowId: number, ownerJobId: number | null): void {
  const ids = new Set<number>(ownerJobId == null ? [] : [ownerJobId]);
  for (const job of listActiveJobs(db)) {
    if (parseIds(job.after).includes(windowId)) ids.add(job.id);
  }
  for (const id of ids) settleAndAnnounce(db, bus, id);
}

/**
 * Close a running job as stopped because the operator said so, whatever its
 * legs are doing. settleJob cannot do this: a job whose only running leg is a
 * window another job opened stays running until that window closes, and the
 * stop route has no way to close a row it does not own.
 */
export function stopJob(db: Db, bus: EventBus, id: number, note: string): JobRow | null {
  const { changes } = db.run("UPDATE jobs SET state = 'stopped', finished_at = ?, cloud_pending = 0 WHERE id = ? AND state = 'running'", [
    new Date().toISOString(),
    id,
  ]);
  if (changes === 0) return getJob(db, id);
  noteJob(db, id, note);
  const row = getJob(db, id);
  if (row) bus.emit({ type: "job", job: toJobView(db, row) });
  return row;
}

/** Settle, and tell the bus if the job closed. One line at every leg's end. */
export function settleAndAnnounce(db: Db, bus: EventBus, id: number | null | undefined): JobRow | null {
  if (id == null) return null;
  const out = settleJob(db, id);
  if (!out) return null;
  if (out.changed) bus.emit({ type: "job", job: toJobView(db, out.job) });
  return out.job;
}

function stateOf(windows: WindowRow[], runs: RunRow[], legsFailed: number): JobState {
  const total = windows.length + runs.length + legsFailed;
  if (total === 0) return "failed";
  const done = windows.filter((w) => w.state === "done").length + runs.filter((r) => r.state === "done").length;
  const stopped =
    windows.filter((w) => w.state === "stopped").length + runs.filter((r) => r.state === "stopped").length;
  const bad = total - done - stopped;
  if (done === total) return "done";
  if (bad === 0) return "stopped";
  if (done === 0 && stopped === 0) return "failed";
  return "partial";
}

/**
 * Close out every job still marked running. Called at boot after the runs
 * and windows have been abandoned, so their rows are already closed; what
 * is left is the cloud leg a Sync now chain was waiting to start, and that
 * wait lived in the previous process's memory.
 */
export function abandonStaleJobs(db: Db): number {
  let n = 0;
  for (const job of listActiveJobs(db)) {
    // A job held open mid-open: the process died between two window opens,
    // so no further leg is coming and the hold has nothing left to protect.
    if (job.opening === 1) setJobOpening(db, job.id, false);
    if (job.cloud_pending === 1) {
      noteJob(db, job.id, "cloud leg never started — SyncCenter restarted while the windows were open");
      db.run("UPDATE jobs SET cloud_pending = 0, legs_failed = legs_failed + ? WHERE id = ?", [
        parseStrings(job.cloud).length,
        job.id,
      ]);
    }
    const out = settleJob(db, job.id);
    if (out?.changed) n += 1;
  }
  return n;
}

export function toJobView(db: Db, row: JobRow): JobView {
  return toJobViews(db, [row])[0]!;
}

/** Attach legs and totals to a page of jobs in two queries, not two per job. */
export function toJobViews(db: Db, rows: JobRow[]): JobView[] {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const afterIds = rows.flatMap((r) => parseIds(r.after));
  const windows = listWindowsForJobs(db, ids, afterIds);
  const runs = listRunsForJobs(db, ids);
  const now = Date.now();
  return rows.map((row) => {
    const after = parseIds(row.after);
    const own = windows.filter((w) => w.job_id === row.id || after.includes(w.id));
    const mine = runs.filter((r) => r.job_id === row.id);
    return {
      id: row.id,
      folder: row.folder,
      kind: row.kind,
      via: row.via,
      started_at: row.started_at,
      finished_at: row.finished_at,
      state: row.state,
      hosts: parseStrings(row.hosts),
      cloud: parseStrings(row.cloud),
      after,
      cloudPending: row.cloud_pending === 1,
      legsFailed: row.legs_failed,
      note: row.note,
      actor: row.actor,
      source: row.source,
      windows: own.map(toWindowView),
      runs: mine.map(toView),
      totals: totalsOf(row, own, mine, now),
    };
  });
}

function totalsOf(job: JobRow, windows: WindowRow[], runs: RunRow[], now: number): JobTotals {
  const span = (from: string, to: string | null) =>
    Math.max(0, ((to ? new Date(to).getTime() : now) - new Date(from).getTime()) / 1000);
  const legs = windows.length + runs.length + job.legs_failed;
  const legsDone = windows.filter((w) => w.state === "done").length + runs.filter((r) => r.state === "done").length;
  const legsRunning =
    windows.filter((w) => w.state === "running").length + runs.filter((r) => r.state === "running").length;
  const legsStopped =
    windows.filter((w) => w.state === "stopped").length + runs.filter((r) => r.state === "stopped").length;
  return {
    bytes: sum(runs, (r) => r.bytes),
    totalBytes: sum(runs, (r) => r.total_bytes),
    transfers: sum(runs, (r) => r.transfers),
    checks: sum(runs, (r) => r.checks),
    listed: sum(runs, (r) => r.listed),
    errors: sum(runs, (r) => r.errors) + sum(windows, (w) => w.errors),
    needFiles: sum(windows, (w) => w.need_files),
    needBytes: sum(windows, (w) => w.need_bytes),
    seconds: Math.round(span(job.started_at, job.finished_at)),
    windowSeconds: Math.round(sum(windows, (w) => span(w.started_at, w.finished_at))),
    runSeconds: Math.round(sum(runs, (r) => span(r.started_at, r.finished_at))),
    capSeconds: sum(windows, (w) => w.max_minutes * 60),
    legs,
    legsDone,
    legsRunning,
    legsFailed: legs - legsDone - legsRunning - legsStopped,
  };
}

function sum<T>(items: T[], pick: (t: T) => number): number {
  let n = 0;
  for (const it of items) n += pick(it);
  return n;
}

/** The JSON arrays on the row are written by this module; anything else reads as empty. */
/** The window ids in a job's `after`, the legs it rides but did not open. */
export function parseIds(json: string): number[] {
  const v = parseJson(json);
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [];
}

function parseStrings(json: string): string[] {
  const v = parseJson(json);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
