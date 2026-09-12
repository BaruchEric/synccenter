import { Router } from "express";
import type { Db } from "../db.ts";
import { nextBefore, pageParams } from "../lib/paging.ts";
import { listActiveWindows, listWindows, getWindow, toWindowView } from "../lib/windows-service.ts";
import { SyncWindowError, type SyncWindowEngine } from "../lib/sync-windows.ts";

export function windowsRouter(db: Db, engine: SyncWindowEngine): Router {
  const r = Router();

  r.get("/windows", (req, res) => {
    const page = pageParams(req.query, { max: 200, fallback: 50 });
    const folder = typeof req.query.folder === "string" ? req.query.folder : undefined;
    const rows = listWindows(db, { ...page, ...(folder ? { folder } : {}) });
    res.json({
      windows: rows.map(toWindowView),
      activeCount: listActiveWindows(db).length,
      nextBefore: nextBefore(rows, page.limit),
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

  r.post("/windows/:id/extend", (req, res) => {
    const row = getWindow(db, Number(req.params.id));
    if (!row) { res.status(404).json({ error: "window not found" }); return; }
    if (row.state !== "running") { res.status(409).json({ error: "window is no longer running" }); return; }
    const minutes = req.body?.maxMinutes;
    if (!Number.isInteger(minutes) || minutes < row.max_minutes || minutes > 720) {
      res.status(400).json({ error: "maxMinutes must extend the current cap, up to 720 minutes" }); return;
    }
    db.run("UPDATE sync_windows SET max_minutes = ? WHERE id = ? AND state = 'running'", [minutes, row.id]);
    res.json({ window: toWindowView(getWindow(db, row.id)!) });
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
    case "CLOUD_RUNNING":
      return 409;
    default:
      return 400;
  }
}
