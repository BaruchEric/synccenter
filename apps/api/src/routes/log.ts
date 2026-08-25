import { Router } from "express";
import type { Log, LogLevel } from "../lib/log.ts";

const LEVELS = new Set<LogLevel>(["info", "warn", "error"]);

export function logRouter(log: Log): Router {
  const r = Router();

  /**
   * SyncCenter's own log, newest first. `before=<id>` pages older; the
   * response's `nextBefore` is the cursor for the following page, or null
   * when the page came back short.
   */
  r.get("/log", (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100) || 100));
    const before = Number(req.query.before);
    const level = typeof req.query.level === "string" ? req.query.level : "";
    const lines = log.list({
      limit,
      ...(Number.isInteger(before) && before > 0 ? { before } : {}),
      ...(typeof req.query.folder === "string" && req.query.folder ? { folder: req.query.folder } : {}),
      ...(isLevel(level) ? { level } : {}),
      ...(typeof req.query.source === "string" && req.query.source ? { source: req.query.source } : {}),
      ...(typeof req.query.q === "string" && req.query.q ? { q: req.query.q } : {}),
    });
    res.json({
      lines,
      nextBefore: lines.length === limit ? lines[lines.length - 1]!.id : null,
    });
  });

  return r;
}

function isLevel(v: string): v is LogLevel {
  return LEVELS.has(v as LogLevel);
}
