import { Router } from "express";
import type { Db } from "../db.ts";
import { nextBefore, pageParams } from "../lib/paging.ts";

interface HistoryRow {
  id: number;
  ts: string;
  actor: string;
  source: string;
  target_kind: string;
  target_name: string;
  payload_hash: string;
  result: string;
  note: string | null;
}

function kindOf(payloadHash: string): "apply" | "bisync" | "sync-window" {
  return payloadHash === "bisync" || payloadHash === "sync-window" ? payloadHash : "apply";
}

export function systemRouter(db: Db): Router {
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
    res.json({ jobs: [] });
  });

  /**
   * The ledger, newest first. `kind` is derived from how the row was written:
   * bisync runs and sync windows tag `payload_hash` with their name, applies
   * store a real hash.
   */
  r.get("/apply-history", (req, res) => {
    const page = pageParams(req.query, { max: 500, fallback: 50 });
    const where: string[] = [];
    const params: Array<number | string> = [];
    if (page.before !== undefined) {
      where.push("id < ?");
      params.push(page.before);
    }
    if (typeof req.query.folder === "string" && req.query.folder) {
      where.push("target_name = ?");
      params.push(req.query.folder);
    }
    if (typeof req.query.result === "string" && ["ok", "error", "dry-run"].includes(req.query.result)) {
      where.push("result = ?");
      params.push(req.query.result);
    }
    const kind = typeof req.query.kind === "string" ? req.query.kind : "";
    if (kind === "bisync" || kind === "sync-window") {
      where.push("payload_hash = ?");
      params.push(kind);
    } else if (kind === "apply") {
      where.push("payload_hash NOT IN ('bisync', 'sync-window')");
    }
    const rows = db
      .query<HistoryRow, Array<number | string>>(
        `SELECT id, ts, actor, source, target_kind, target_name, payload_hash, result, note
         FROM apply_history${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
         ORDER BY id DESC LIMIT ?`,
      )
      .all(...params, page.limit);
    res.json({
      history: rows.map(({ payload_hash, ...row }) => ({ ...row, kind: kindOf(payload_hash) })),
      nextBefore: nextBefore(rows, page.limit),
    });
  });

  r.post("/apply", (_req, res) => {
    res.status(501).json({
      error: "POST /apply is a multi-resource batch — use /folders/:name/apply for per-folder apply, or wait for batch support",
    });
  });

  return r;
}
