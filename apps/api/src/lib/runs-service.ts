import type { Db } from "../db.ts";

/** A row of the `runs` table — one async rclone bisync. */
export interface RunRow {
  id: number;
  folder: string;
  member: string | null;
  jobid: number | null;
  stats_group: string | null;
  started_at: string;
  finished_at: string | null;
  state: "running" | "done" | "failed" | "stopped";
  bytes: number;
  total_bytes: number;
  transfers: number;
  checks: number;
  listed: number;
  errors: number;
  speed: number;
  eta: number | null;
  current: string | null;
  error: string | null;
  actor: string;
  source: "api" | "cli" | "ui" | "mcp";
  dry_run: number;
  resync: number;
  misses: number;
}

/**
 * What the run is doing right now.
 *
 * bisync spends most of its wall-clock walking both trees before it moves a
 * byte, so `totalBytes` sits at 0 while `checks`/`listed` climb. Reporting that
 * as "0%" would read as stalled for minutes on a large folder — it gets its own
 * phase instead, and the meter only appears once there is a denominator.
 */
export type RunPhase = "starting" | "checking" | "transferring" | "finished";

export function phaseOf(r: RunRow): RunPhase {
  if (r.state !== "running") return "finished";
  if (r.total_bytes > 0) return "transferring";
  if (r.checks > 0 || r.listed > 0) return "checking";
  return "starting";
}

/** The wire shape: the row plus the fields the UI would otherwise re-derive. */
export interface RunView extends RunRow {
  phase: RunPhase;
  /** 0–1, or null while there is no denominator to divide by. */
  fraction: number | null;
}

export function toView(r: RunRow): RunView {
  const phase = phaseOf(r);
  return {
    ...r,
    phase,
    fraction:
      r.total_bytes > 0 ? Math.min(1, r.bytes / r.total_bytes) : r.state === "done" ? 1 : null,
  };
}

export interface StartRunInput {
  folder: string;
  member?: string | null;
  jobid?: number | null;
  statsGroup?: string | null;
  actor: string;
  source: RunRow["source"];
  dryRun?: boolean;
  resync?: boolean;
}

export function startRun(db: Db, input: StartRunInput): RunRow {
  const { lastInsertRowid } = db.run(
    `INSERT INTO runs (folder, member, jobid, stats_group, started_at, state, actor, source, dry_run, resync)
     VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
    [
      input.folder,
      input.member ?? null,
      input.jobid ?? null,
      input.statsGroup ?? null,
      new Date().toISOString(),
      input.actor,
      input.source,
      input.dryRun ? 1 : 0,
      input.resync ? 1 : 0,
    ],
  );
  return getRun(db, Number(lastInsertRowid))!;
}

export function getRun(db: Db, id: number): RunRow | null {
  return (db.query("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | null) ?? null;
}

export function listRuns(db: Db, limit = 50): RunRow[] {
  return db.query("SELECT * FROM runs ORDER BY id DESC LIMIT ?").all(limit) as RunRow[];
}

export function listActiveRuns(db: Db): RunRow[] {
  return db.query("SELECT * FROM runs WHERE state = 'running' ORDER BY id ASC").all() as RunRow[];
}

/** Live counters from an rclone stats poll. */
export interface RunProgress {
  bytes?: number;
  totalBytes?: number;
  transfers?: number;
  checks?: number;
  listed?: number;
  errors?: number;
  speed?: number;
  eta?: number | null;
  current?: string | null;
}

export function updateProgress(db: Db, id: number, p: RunProgress): void {
  db.run(
    `UPDATE runs SET bytes = ?, total_bytes = ?, transfers = ?, checks = ?, listed = ?,
       errors = ?, speed = ?, eta = ?, current = ?, misses = 0
     WHERE id = ? AND state = 'running'`,
    [
      p.bytes ?? 0,
      p.totalBytes ?? 0,
      p.transfers ?? 0,
      p.checks ?? 0,
      p.listed ?? 0,
      p.errors ?? 0,
      p.speed ?? 0,
      p.eta ?? null,
      p.current ?? null,
      id,
    ],
  );
}

/** Count a failed poll. Returns the new miss count. */
export function recordMiss(db: Db, id: number): number {
  db.run("UPDATE runs SET misses = misses + 1 WHERE id = ? AND state = 'running'", [id]);
  return getRun(db, id)?.misses ?? 0;
}

export function finishRun(
  db: Db,
  id: number,
  state: "done" | "failed" | "stopped",
  error?: string | null,
): RunRow | null {
  db.run(
    `UPDATE runs SET state = ?, finished_at = ?, error = ?, speed = 0, eta = NULL, current = NULL
     WHERE id = ? AND state = 'running'`,
    [state, new Date().toISOString(), error ?? null, id],
  );
  return getRun(db, id);
}

/**
 * Mark every in-flight run failed. Called at boot: the rcd's job ids do not
 * survive a restart of either process, so a run still marked `running` from a
 * previous life would otherwise poll a job id that now belongs to nothing (or,
 * worse, to somebody else's job) forever.
 */
export function abandonStaleRuns(db: Db): number {
  const { changes } = db.run(
    `UPDATE runs SET state = 'failed', finished_at = ?, error = 'interrupted — SyncCenter restarted while this run was in flight'
     WHERE state = 'running'`,
    [new Date().toISOString()],
  );
  return Number(changes);
}
