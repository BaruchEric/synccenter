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
];

export function openDb(path: string): Db {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  for (const stmt of SCHEMA) db.exec(stmt);
  return db;
}
