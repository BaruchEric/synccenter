import { Router } from "express";
import type { ApiConfig } from "../config.ts";
import type { Db } from "../db.ts";

const NOT_IMPL = "this endpoint needs the Syncthing/rclone adapters (Phase 3 wiring) — not yet implemented";

export function systemRouter(_cfg: ApiConfig, db: Db): Router {
  const r = Router();

  r.get("/conflicts", (_req, res) => {
    const rows = db
      .query<{ id: number; folder: string; path: string; detected_at: string }, []>(
        `SELECT id, folder, path, detected_at FROM conflict_ledger WHERE resolved_at IS NULL ORDER BY detected_at DESC`,
      )
      .all();
    res.json({ conflicts: rows });
  });

  r.get("/jobs", (_req, res) => {
    // No job runner yet; returns empty list so the UI/CLI can be stubbed against it.
    res.json({ jobs: [] });
  });

  r.get("/apply-history", (_req, res) => {
    const rows = db
      .query(
        `SELECT id, ts, actor, source, target_kind, target_name, result, note
         FROM apply_history ORDER BY id DESC LIMIT 50`,
      )
      .all();
    res.json({ history: rows });
  });

  r.post("/apply", (_req, res) => {
    res.status(501).json({ error: NOT_IMPL });
  });

  r.post("/folders/:name/pause", (_req, res) => {
    res.status(501).json({ error: NOT_IMPL });
  });

  r.post("/folders/:name/resume", (_req, res) => {
    res.status(501).json({ error: NOT_IMPL });
  });

  r.post("/folders/:name/bisync", (_req, res) => {
    res.status(501).json({ error: NOT_IMPL });
  });

  return r;
}
