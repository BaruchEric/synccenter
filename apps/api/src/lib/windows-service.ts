import type { Db } from "../db.ts";

/** A row of `sync_windows` — one resume→catch-up→pause pass on one host. */
export interface WindowRow {
  id: number;
  folder: string;
  host: string;
  via: "schedule" | "manual";
  started_at: string;
  finished_at: string | null;
  state: "running" | "done" | "failed" | "timeout" | "stopped";
  max_minutes: number;
  sync_state: string | null;
  global_bytes: number;
  in_sync_bytes: number;
  need_bytes: number;
  need_files: number;
  errors: number;
  peers_total: number;
  peers_done: number;
  error: string | null;
  actor: string;
  source: "api" | "cli" | "ui" | "mcp" | "schedule";
  misses: number;
  /** The job this window is a leg of; null on rows from before jobs existed. */
  job_id: number | null;
}

/**
 * What the window is doing right now. `starting` covers resume until the first
 * status lands; `scanning` while Syncthing walks the tree (no denominator);
 * `syncing` while data moves; `settling` once this host is caught up and we
 * are waiting for connected peers to finish pulling from it.
 */
export type WindowPhase = "starting" | "scanning" | "syncing" | "settling" | "finished";

const SCAN_STATES = new Set(["scanning", "scan-waiting", "cleaning", "cleaning-waiting"]);

export function phaseOf(w: WindowRow): WindowPhase {
  if (w.state !== "running") return "finished";
  const s = w.sync_state;
  if (!s || s === "paused") return "starting";
  if (SCAN_STATES.has(s)) return "scanning";
  if (s === "idle" && w.need_bytes === 0 && w.need_files === 0) return "settling";
  return "syncing";
}

/** The wire shape: the row plus the fields the UI would otherwise re-derive. */
export interface WindowView extends WindowRow {
  phase: WindowPhase;
  /** 0–1 of the tree in sync locally, or null while there is no denominator. */
  fraction: number | null;
}

export function toWindowView(w: WindowRow): WindowView {
  const fraction =
    w.global_bytes > 0
      ? Math.min(1, w.in_sync_bytes / w.global_bytes)
      : w.state === "done"
        ? 1
        : null;
  return { ...w, phase: phaseOf(w), fraction };
}

export interface StartWindowInput {
  folder: string;
  host: string;
  via: WindowRow["via"];
  maxMinutes: number;
  actor: string;
  source: WindowRow["source"];
  /** The engine's clock, so tests can drive time. Defaults to real now. */
  startedAt?: Date;
  /** The job this window belongs to. */
  jobId?: number | null;
}

export function startWindow(db: Db, input: StartWindowInput): WindowRow {
  const { lastInsertRowid } = db.run(
    `INSERT INTO sync_windows (folder, host, via, started_at, state, max_minutes, actor, source, job_id)
     VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
    [
      input.folder,
      input.host,
      input.via,
      (input.startedAt ?? new Date()).toISOString(),
      input.maxMinutes,
      input.actor,
      input.source,
      input.jobId ?? null,
    ],
  );
  return getWindow(db, Number(lastInsertRowid))!;
}

export function getWindow(db: Db, id: number): WindowRow | null {
  return (db.query("SELECT * FROM sync_windows WHERE id = ?").get(id) as WindowRow | null) ?? null;
}

export interface ListOpts {
  limit?: number;
  /** Only rows with an id below this one — the cursor for "load older". */
  before?: number;
  folder?: string;
}

export function listWindows(db: Db, limitOrOpts: number | ListOpts = 50): WindowRow[] {
  const opts = typeof limitOrOpts === "number" ? { limit: limitOrOpts } : limitOrOpts;
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
  return db
    .query(`SELECT * FROM sync_windows${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
    .all(...params, opts.limit ?? 50) as WindowRow[];
}

export function listActiveWindows(db: Db): WindowRow[] {
  return db
    .query("SELECT * FROM sync_windows WHERE state = 'running' ORDER BY id ASC")
    .all() as WindowRow[];
}

/** Every window that is a leg of one of these jobs, or one they ride on, oldest first. */
export function listWindowsForJobs(db: Db, jobIds: number[], extraIds: number[] = []): WindowRow[] {
  if (jobIds.length === 0 && extraIds.length === 0) return [];
  const clauses: string[] = [];
  const params: number[] = [];
  if (jobIds.length > 0) {
    clauses.push(`job_id IN (${jobIds.map(() => "?").join(",")})`);
    params.push(...jobIds);
  }
  if (extraIds.length > 0) {
    clauses.push(`id IN (${extraIds.map(() => "?").join(",")})`);
    params.push(...extraIds);
  }
  return db
    .query(`SELECT * FROM sync_windows WHERE ${clauses.join(" OR ")} ORDER BY id ASC`)
    .all(...params) as WindowRow[];
}

export function activeWindowFor(db: Db, folder: string, host: string): WindowRow | null {
  return (
    (db
      .query("SELECT * FROM sync_windows WHERE state = 'running' AND folder = ? AND host = ?")
      .get(folder, host) as WindowRow | null) ?? null
  );
}

/** Live counters from one Syncthing status poll. */
export interface WindowProgress {
  syncState: string;
  globalBytes: number;
  inSyncBytes: number;
  needBytes: number;
  needFiles: number;
  errors: number;
  peersTotal?: number;
  peersDone?: number;
}

export function updateWindowProgress(db: Db, id: number, p: WindowProgress): void {
  db.run(
    `UPDATE sync_windows SET sync_state = ?, global_bytes = ?, in_sync_bytes = ?, need_bytes = ?,
       need_files = ?, errors = ?, peers_total = ?, peers_done = ?, misses = 0
     WHERE id = ? AND state = 'running'`,
    [
      p.syncState,
      p.globalBytes,
      p.inSyncBytes,
      p.needBytes,
      p.needFiles,
      p.errors,
      p.peersTotal ?? 0,
      p.peersDone ?? 0,
      id,
    ],
  );
}

/** Count a failed poll. Returns the new miss count. */
export function recordWindowMiss(db: Db, id: number): number {
  db.run("UPDATE sync_windows SET misses = misses + 1 WHERE id = ? AND state = 'running'", [id]);
  return getWindow(db, id)?.misses ?? 0;
}

export function finishWindow(
  db: Db,
  id: number,
  state: "done" | "failed" | "timeout" | "stopped",
  error?: string | null,
): WindowRow | null {
  db.run(
    `UPDATE sync_windows SET state = ?, finished_at = ?, error = ?
     WHERE id = ? AND state = 'running'`,
    [state, new Date().toISOString(), error ?? null, id],
  );
  return getWindow(db, id);
}

/**
 * Mark every in-flight window failed. Called at boot: whether the folder was
 * left paused or resumed by the previous life is unknowable from here, so the
 * row is closed out and the reconciler re-pauses whatever needs it.
 */
export function abandonStaleWindows(db: Db): number {
  const { changes } = db.run(
    `UPDATE sync_windows SET state = 'failed', finished_at = ?, error = 'interrupted — SyncCenter restarted while this window was open'
     WHERE state = 'running'`,
    [new Date().toISOString()],
  );
  return Number(changes);
}
