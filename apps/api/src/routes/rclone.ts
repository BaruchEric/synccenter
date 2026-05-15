import { Router, type Response } from "express";
import { RcloneClient, RcloneError } from "@synccenter/adapters";

const NO_RCLONE = "rclone is not configured on this SyncCenter instance (set SC_RCLONE_URL)";

export function rcloneRouter(rclone: RcloneClient | null): Router {
  const r = Router();

  r.get("/rclone/version", async (_req, res) => {
    if (!rclone) {
      res.status(503).json({ error: NO_RCLONE });
      return;
    }
    try {
      res.json(await rclone.getVersion());
    } catch (err) {
      respond(res, err);
    }
  });

  r.get("/rclone/remotes", async (_req, res) => {
    if (!rclone) {
      res.status(503).json({ error: NO_RCLONE });
      return;
    }
    try {
      res.json(await rclone.listRemotes());
    } catch (err) {
      respond(res, err);
    }
  });

  r.get("/rclone/jobs/:jobid", async (req, res) => {
    if (!rclone) {
      res.status(503).json({ error: NO_RCLONE });
      return;
    }
    const jobid = Number(req.params.jobid);
    if (!Number.isInteger(jobid) || jobid <= 0) {
      res.status(400).json({ error: `invalid jobid: ${req.params.jobid}` });
      return;
    }
    try {
      res.json(await rclone.jobStatus(jobid));
    } catch (err) {
      respond(res, err);
    }
  });

  r.get("/rclone/stats", async (req, res) => {
    if (!rclone) {
      res.status(503).json({ error: NO_RCLONE });
      return;
    }
    const group = typeof req.query.group === "string" ? req.query.group : undefined;
    try {
      res.json(await rclone.getStats(group));
    } catch (err) {
      respond(res, err);
    }
  });

  return r;
}

function respond(res: Response, err: unknown): void {
  if (err instanceof RcloneError) {
    res.status(err.status && err.status >= 400 && err.status < 600 ? 502 : 500).json({
      error: err.message,
      endpoint: err.endpoint,
      upstreamStatus: err.status,
    });
    return;
  }
  res.status(500).json({ error: (err as Error).message ?? "internal error" });
}
