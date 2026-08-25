import { Router } from "express";
import type { Db } from "../db.ts";
import { listActiveWindows, listWindows, getWindow, toWindowView } from "../lib/windows-service.ts";
import { SyncWindowError, type SyncWindowEngine } from "../lib/sync-windows.ts";

export function windowsRouter(db: Db, engine: SyncWindowEngine): Router {
  const r = Router();

  r.get("/windows", (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50) || 50));
    const before = Number(req.query.before);
    const folder = typeof req.query.folder === "string" ? req.query.folder : undefined;
    const rows = listWindows(db, {
      limit,
      ...(Number.isInteger(before) && before > 0 ? { before } : {}),
      ...(folder ? { folder } : {}),
    });
    res.json({
      windows: rows.map(toWindowView),
      activeCount: listActiveWindows(db).length,
      // Cursor for the next page; null once the page came back short.
      nextBefore: rows.length === limit ? rows[rows.length - 1]!.id : null,
    });
  });

  r.get("/windows/:id", (req, res) => {
    const row = getWindow(db, Number(req.params.id));
    if (!row) {
      res.status(404).json({ error: `window not found: ${req.params.id}` });
      return;
    }
    res.json({ window: toWindowView(row) });
  });

  r.post("/windows/:id/stop", async (req, res) => {
    const row = getWindow(db, Number(req.params.id));
    if (!row) {
      res.status(404).json({ error: `window not found: ${req.params.id}` });
      return;
    }
    const out = await engine.stopWindow(row.id);
    res.json({ window: toWindowView(out ?? row) });
  });

  return r;
}

/** Shared by the folders router: map a SyncWindowError to an HTTP status. */
export function syncWindowErrorStatus(err: SyncWindowError): number {
  switch (err.code) {
    case "NOT_FOUND":
      return 404;
    case "ALREADY_OPEN":
      return 409;
    default:
      return 400;
  }
}
