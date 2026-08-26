import { Database } from "bun:sqlite";

export type Db = Database;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS apply_history (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts TEXT NOT NULL,
     actor TEXT NOT NULL,
     source TEXT NOT NULL CHECK (source IN ('api','cli','ui','mcp')),
     target_kind TEXT NOT NULL CHECK (target_kind IN ('folder','ruleset','host','schedule')),
     target_name TEXT NOT NULL,
     payload_hash TEXT NOT NULL,
     result TEXT NOT NULL CHECK (result IN ('ok','error','dry-run')),
     note TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS apply_history_target ON apply_history (target_kind, target_name)`,
  `CREATE INDEX IF NOT EXISTS apply_history_name ON apply_history (target_name, id DESC)`,

  `CREATE TABLE IF NOT EXISTS conflict_ledger (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     folder TEXT NOT NULL,
     path TEXT NOT NULL,
     detected_at TEXT NOT NULL,
     resolved_at TEXT,
     resolution TEXT CHECK (resolution IN ('newer','older','both','manual','superseded')),
     UNIQUE (folder, path)
   )`,
  `CREATE INDEX IF NOT EXISTS conflict_ledger_unresolved ON conflict_ledger (folder) WHERE resolved_at IS NULL`,

  // Async rclone bisync jobs, tracked while they run so the UI can show live
  // progress. Deliberately NOT a home for applies: those are synchronous and
  // already recorded in apply_history, and a second ledger would double them
  // up on the activity timeline.
  `CREATE TABLE IF NOT EXISTS runs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     folder TEXT NOT NULL,
     member TEXT,
     jobid INTEGER,
     stats_group TEXT,
     started_at TEXT NOT NULL,
     finished_at TEXT,
     state TEXT NOT NULL CHECK (state IN ('running','done','failed','stopped')),
     bytes INTEGER NOT NULL DEFAULT 0,
     total_bytes INTEGER NOT NULL DEFAULT 0,
     transfers INTEGER NOT NULL DEFAULT 0,
     checks INTEGER NOT NULL DEFAULT 0,
     listed INTEGER NOT NULL DEFAULT 0,
     errors INTEGER NOT NULL DEFAULT 0,
     speed REAL NOT NULL DEFAULT 0,
     eta INTEGER,
     current TEXT,
     error TEXT,
     actor TEXT NOT NULL,
     source TEXT NOT NULL CHECK (source IN ('api','cli','ui','mcp')),
     dry_run INTEGER NOT NULL DEFAULT 0,
     resync INTEGER NOT NULL DEFAULT 0,
     misses INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS runs_active ON runs (state) WHERE state = 'running'`,
  `CREATE INDEX IF NOT EXISTS runs_recent ON runs (started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS runs_folder ON runs (folder, id DESC)`,

  // Sync windows: the stretches where a scheduled/manual Syncthing member
  // (paused the rest of the time) is resumed, catches up, and is paused again.
  // One row per window per host, updated live while it runs so the UI can show
  // progress the same way it shows bisync runs.
  `CREATE TABLE IF NOT EXISTS sync_windows (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     folder TEXT NOT NULL,
     host TEXT NOT NULL,
     via TEXT NOT NULL CHECK (via IN ('schedule','manual')),
     started_at TEXT NOT NULL,
     finished_at TEXT,
     state TEXT NOT NULL CHECK (state IN ('running','done','failed','timeout','stopped')),
     max_minutes INTEGER NOT NULL DEFAULT 60,
     sync_state TEXT,
     global_bytes INTEGER NOT NULL DEFAULT 0,
     in_sync_bytes INTEGER NOT NULL DEFAULT 0,
     need_bytes INTEGER NOT NULL DEFAULT 0,
     need_files INTEGER NOT NULL DEFAULT 0,
     errors INTEGER NOT NULL DEFAULT 0,
     peers_total INTEGER NOT NULL DEFAULT 0,
     peers_done INTEGER NOT NULL DEFAULT 0,
     error TEXT,
     actor TEXT NOT NULL,
     source TEXT NOT NULL CHECK (source IN ('api','cli','ui','mcp','schedule')),
     misses INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS sync_windows_active ON sync_windows (state) WHERE state = 'running'`,
  `CREATE INDEX IF NOT EXISTS sync_windows_recent ON sync_windows (started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS sync_windows_folder ON sync_windows (folder, id DESC)`,

  // SyncCenter's own operational log: what the engine, the run tracker and
  // the mutation routes did and why, one line per step. apply_history is the
  // ledger (one row per finished operation); this is the narrative between
  // the rows, the part that used to exist only as container stdout.
  `CREATE TABLE IF NOT EXISTS log_lines (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts TEXT NOT NULL,
     level TEXT NOT NULL CHECK (level IN ('info','warn','error')),
     source TEXT NOT NULL,
     folder TEXT,
     host TEXT,
     message TEXT NOT NULL,
     data TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS log_lines_folder ON log_lines (folder, id DESC)`,

  // One row per unit of work the API drives, whatever its shape: a Sync now
  // chain (windows, then the cloud bisync), a scheduled window on its own, a
  // bisync started on its own. Runs and windows point at their job, so "what
  // did that press do" is one id rather than a search across two tables.
  // `hosts`/`cloud` are the legs planned at the start (JSON arrays), `after`
  // the window ids the cloud leg waits on (own or adopted), `legs_failed`
  // the legs that never got a row — a window that could not open, a bisync
  // that did not start — with the reason in `note`.
  `CREATE TABLE IF NOT EXISTS jobs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     folder TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('sync','bisync','window')),
     via TEXT NOT NULL CHECK (via IN ('manual','schedule')),
     started_at TEXT NOT NULL,
     finished_at TEXT,
     state TEXT NOT NULL CHECK (state IN ('running','done','partial','failed','stopped')),
     hosts TEXT NOT NULL DEFAULT '[]',
     cloud TEXT NOT NULL DEFAULT '[]',
     after TEXT NOT NULL DEFAULT '[]',
     cloud_pending INTEGER NOT NULL DEFAULT 0,
     legs_failed INTEGER NOT NULL DEFAULT 0,
     note TEXT,
     actor TEXT NOT NULL,
     source TEXT NOT NULL CHECK (source IN ('api','cli','ui','mcp','schedule'))
   )`,
  `CREATE INDEX IF NOT EXISTS jobs_active ON jobs (state) WHERE state = 'running'`,
  `CREATE INDEX IF NOT EXISTS jobs_recent ON jobs (started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS jobs_folder ON jobs (folder, id DESC)`,
];

/**
 * Columns added after a table first shipped. CREATE TABLE IF NOT EXISTS
 * leaves an existing table alone, so these are applied one by one against
 * `PRAGMA table_info`; a database from before the column gets it, one from
 * after is untouched. Rows that predate the column read NULL.
 */
const COLUMNS: Array<[table: string, column: string, ddl: string]> = [
  ["runs", "job_id", "INTEGER"],
  ["sync_windows", "job_id", "INTEGER"],
];
const COLUMN_INDEXES = [
  `CREATE INDEX IF NOT EXISTS runs_job ON runs (job_id)`,
  `CREATE INDEX IF NOT EXISTS sync_windows_job ON sync_windows (job_id)`,
];

export function openDb(path: string): Db {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  for (const stmt of SCHEMA) db.exec(stmt);
  for (const [table, column, ddl] of COLUMNS) {
    if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
  for (const stmt of COLUMN_INDEXES) db.exec(stmt);
  return db;
}

function hasColumn(db: Db, table: string, column: string): boolean {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}
