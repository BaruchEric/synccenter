import { Router } from "express";
import { RcloneClient, RcloneError } from "@synccenter/adapters";
import type { Db } from "../db.ts";
import type { EventBus } from "../lib/bus.ts";
import { nextBefore, pageParams } from "../lib/paging.ts";
import {
  getJob,
  listActiveJobs,
  listJobs,
  noteJob,
  parseIds,
  setCloudPending,
  settleAndAnnounce,
  stopJob,
  toJobView,
  toJobViews,
  type JobKind,
  type JobState,
} from "../lib/jobs-service.ts";
import { finishRun, listRunsForJobs, toView } from "../lib/runs-service.ts";
import type { SyncWindowEngine } from "../lib/sync-windows.ts";
import { listWindowsForJobs } from "../lib/windows-service.ts";

const KINDS = new Set<JobKind>(["sync", "bisync", "window"]);
const STATES = new Set<JobState>(["running", "done", "partial", "failed", "stopped"]);

export function jobsRouter(db: Db, bus: EventBus, engine: SyncWindowEngine, rclone: RcloneClient | null): Router {
  const r = Router();

  /** Jobs newest first, each with its legs and totals. Same cursor as /runs. */
  r.get("/jobs", (req, res) => {
    const page = pageParams(req.query, { max: 200, fallback: 50 });
    const folder = typeof req.query.folder === "string" ? req.query.folder : undefined;
    const kind = typeof req.query.kind === "string" && isKind(req.query.kind) ? req.query.kind : undefined;
    const state = typeof req.query.state === "string" && isState(req.query.state) ? req.query.state : undefined;
    const rows = listJobs(db, {
      ...page,
      ...(folder ? { folder } : {}),
      ...(kind ? { kind } : {}),
      ...(state ? { state } : {}),
    });
    res.json({
      jobs: toJobViews(db, rows),
      activeCount: listActiveJobs(db).length,
      nextBefore: nextBefore(rows, page.limit),
    });
  });

  r.get("/jobs/:id", (req, res) => {
    const row = getJob(db, Number(req.params.id));
    if (!row) {
      res.status(404).json({ error: `job not found: ${req.params.id}` });
      return;
    }
    res.json({ job: toJobView(db, row) });
  });

  /**
   * Stop every leg still in flight and drop the cloud leg if it has not
   * started. Windows close through the engine (which re-pauses the folder),
   * runs through rclone; a queued cloud leg sees its windows stop and skips
   * itself, the way a single closed window already does.
   */
  r.post("/jobs/:id/stop", async (req, res) => {
    const row = getJob(db, Number(req.params.id));
    if (!row) {
      res.status(404).json({ error: `job not found: ${req.params.id}` });
      return;
    }
    if (row.state !== "running") {
      res.status(409).json({ error: `job ${row.id} already ${row.state}` });
      return;
    }
    const problems: string[] = [];
    if (row.cloud_pending === 1) {
      noteJob(db, row.id, "stopped from the dashboard before the cloud leg started");
      setCloudPending(db, row.id, false);
    }
    for (const w of listWindowsForJobs(db, [row.id])) {
      if (w.state === "running") await engine.stopWindow(w.id);
    }
    for (const run of listRunsForJobs(db, [row.id])) {
      if (run.state !== "running") continue;
      try {
        if (rclone && run.jobid != null) await rclone.stopJob(run.jobid);
      } catch (err) {
        // A job that already exited 404s; that is stopped enough. Anything
        // else is worth telling the caller, but the row is settled regardless.
        if (!(err instanceof RcloneError)) problems.push(err instanceof Error ? err.message : String(err));
      }
      const stopped = finishRun(db, run.id, "stopped", "stopped from the dashboard");
      if (stopped) bus.emit({ type: "run", run: toView(stopped) });
    }
    let settled = settleAndAnnounce(db, bus, row.id) ?? row;
    if (settled.state === "running") {
      // What is left running is a window this job only rides on: the job that
      // opened it decides when it closes. Everything this job could stop is
      // stopped, so say the job is stopped rather than report a successful
      // stop on a job that stays running — and the queued cloud leg reads the
      // job's state before it fires, so it will not run behind the operator.
      const riding = parseIds(settled.after);
      settled = stopJob(db, bus, row.id, `stopped from the dashboard while riding window${riding.length > 1 ? "s" : ""} #${riding.join(", #")}`) ?? settled;
    }
    res.json({ job: toJobView(db, settled), ...(problems.length > 0 ? { problems } : {}) });
  });

  return r;
}

function isKind(v: string): v is JobKind {
  return KINDS.has(v as JobKind);
}
function isState(v: string): v is JobState {
  return STATES.has(v as JobState);
}
