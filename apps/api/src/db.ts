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
];

export function openDb(path: string): Db {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  for (const stmt of SCHEMA) db.exec(stmt);
  return db;
}
