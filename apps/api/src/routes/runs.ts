import { Router } from "express";
import { RcloneClient, RcloneError } from "@synccenter/adapters";
import type { Db } from "../db.ts";
import type { EventBus } from "../lib/bus.ts";
import { finishRun, getRun, listRuns, toView } from "../lib/runs-service.ts";

export function runsRouter(db: Db, bus: EventBus, rclone: RcloneClient | null): Router {
  const r = Router();

  r.get("/runs", (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50) || 50));
    const rows = listRuns(db, limit);
    const active = rows.filter((x) => x.state === "running");
    res.json({ runs: rows.map(toView), activeCount: active.length });
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
    if (stopped) bus.emit({ type: "run", run: toView(stopped) });
    res.json({ run: stopped ? toView(stopped) : null });
  });

  return r;
}
