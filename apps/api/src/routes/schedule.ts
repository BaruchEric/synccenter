import { Router } from "express";
import { renderCrontab } from "@synccenter/apply-planner";
import type { ApiConfig } from "../config.ts";
import { planScheduleJobs } from "../lib/plan.ts";
import type { SyncWindowEngine } from "../lib/sync-windows.ts";

export function scheduleRouter(cfg: ApiConfig, engine: SyncWindowEngine): Router {
  const router = Router();

  /** The same SchedulePlan the crontab is rendered from, as JSON for the UI. */
  router.get("/schedule", (_req, res) => {
    // Syncthing sync windows are scheduled work too — the cron-driven kind the
    // engine opens itself, as opposed to the crontab-rendered rclone legs.
    let windows: Array<{ folder: string; host: string; cron: string; maxWindowMinutes: number }>;
    try {
      windows = engine
        .syncJobs()
        .filter((j) => j.mode === "scheduled" && j.cron)
        .map((j) => ({ folder: j.folder, host: j.host, cron: j.cron!, maxWindowMinutes: j.maxWindowMinutes }));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
      return;
    }

    // Planned from the manifests alone — no sops, no secrets — so the
    // deployed container answers the same as a workstation would.
    const { jobs, errors } = planScheduleJobs(cfg);
    res.json({ jobs, windows, ...(errors.length > 0 ? { jobsError: errors.join("; ") } : {}) });
  });

  router.get("/schedule/crontab", (_req, res) => {
    const { jobs, errors } = planScheduleJobs(cfg);
    const banner = errors.map((e) => `# warning: ${e}\n`).join("");
    res.type("text/plain").send(`${banner}${renderCrontab(jobs)}`);
  });

  return router;
}
