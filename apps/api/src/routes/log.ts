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
      ...(isIso(req.query.since) ? { since: iso(req.query.since) } : {}),
      ...(isIso(req.query.until) ? { until: iso(req.query.until) } : {}),
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

/** Anything Date.parse understands; `iso` then spells it the way `ts` is written. */
function isIso(v: unknown): v is string {
  return typeof v === "string" && v.length >= 10 && !Number.isNaN(Date.parse(v));
}

/**
 * The row's `ts` is ISO UTC and the filter compares it as text, so the bound
 * has to be spelled the same way: an offset form or a bare date would sort
 * against the digits rather than the instant.
 */
function iso(v: string): string {
  return new Date(v).toISOString();
}
