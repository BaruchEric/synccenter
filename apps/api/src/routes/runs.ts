import { Router } from "express";
import { RcloneClient, RcloneError } from "@synccenter/adapters";
import type { Db } from "../db.ts";
import type { EventBus } from "../lib/bus.ts";
import { nextBefore, pageParams } from "../lib/paging.ts";
import { settleAndAnnounce } from "../lib/jobs-service.ts";
import { finishRun, getRun, listActiveRuns, listRuns, toView } from "../lib/runs-service.ts";

export function runsRouter(db: Db, bus: EventBus, rclone: RcloneClient | null): Router {
  const r = Router();

  r.get("/runs", (req, res) => {
    const page = pageParams(req.query, { max: 200, fallback: 50 });
    const folder = typeof req.query.folder === "string" ? req.query.folder : undefined;
    const rows = listRuns(db, { ...page, ...(folder ? { folder } : {}) });
    res.json({
      runs: rows.map(toView),
      activeCount: listActiveRuns(db).length,
      nextBefore: nextBefore(rows, page.limit),
    });
  });

  r.get("/runs/:id", (req, res) => {
    const row = getRun(db, Number(req.params.id));
    if (!row) {
      res.status(404).json({ error: `run not found: ${req.params.id}` });
      return;
    }
    res.json({ run: toView(row) });
  });

  /** Ask rclone to stop the job, then settle the row so the UI updates now. */
  r.post("/runs/:id/stop", async (req, res) => {
    const row = getRun(db, Number(req.params.id));
    if (!row) {
      res.status(404).json({ error: `run not found: ${req.params.id}` });
      return;
    }
    if (row.state !== "running") {
      res.status(409).json({ error: `run ${row.id} already ${row.state}` });
      return;
    }
    if (!rclone) {
      res.status(503).json({ error: "rclone is not configured (set SC_RCLONE_URL)" });
      return;
    }
    try {
      if (row.jobid != null) await rclone.stopJob(row.jobid);
    } catch (err) {
      // A job that already exited 404s here. That is not a failure to stop it —
      // it is stopped. Settle the row either way rather than stranding it.
      if (!(err instanceof RcloneError)) {
        res.status(500).json({ error: (err as Error).message });
        return;
      }
    }
    const stopped = finishRun(db, row.id, "stopped", "stopped from the dashboard");
    if (stopped) {
      bus.emit({ type: "run", run: toView(stopped) });
      settleAndAnnounce(db, bus, stopped.job_id);
    }
    res.json({ run: stopped ? toView(stopped) : null });
  });

  return r;
}
