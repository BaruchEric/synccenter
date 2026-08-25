import type { Db } from "../db.ts";
import type { EventBus } from "./bus.ts";

export type LogLevel = "info" | "warn" | "error";

/**
 * Who wrote the line. `window` and `reconcile` are the sync-window engine,
 * `bisync` the run tracker and the on-demand trigger, `sync` the Sync-now
 * chain that strings a window and a bisync together, `folder` the manifest
 * routes, `apply` the apply service, `system` boot and housekeeping.
 */
export type LogSource =
  | "window"
  | "schedule"
  | "reconcile"
  | "bisync"
  | "sync"
  | "apply"
  | "folder"
  | "system";

/** One line of SyncCenter's own log, as stored and as pushed over /events. */
export interface LogLine {
  id: number;
  ts: string;
  level: LogLevel;
  source: LogSource;
  folder: string | null;
  host: string | null;
  message: string;
  data: Record<string, unknown> | null;
}

export interface LogEntry {
  level?: LogLevel;
  source: LogSource;
  folder?: string | null;
  host?: string | null;
  message: string;
  /** Anything structured worth keeping next to the line (ids, counts, errors). */
  data?: Record<string, unknown>;
}

export interface LogListOpts {
  limit?: number;
  /** Only lines with an id below this one — the cursor for "load older". */
  before?: number;
  folder?: string;
  level?: LogLevel;
  source?: string;
  /** Case-insensitive substring of the message. */
  q?: string;
}

export interface LogOpts {
  /** Mirror every line to stdout, so `docker logs` still tells the story. */
  stdout?: boolean;
  /** Rows kept in the table; older ones are pruned. Default 20 000. */
  keep?: number;
}

interface LogRow extends Omit<LogLine, "data"> {
  data: string | null;
}

const PRUNE_EVERY = 250;

/**
 * The server's log, written to SQLite and announced on the bus.
 *
 * Why not just stdout: the container's stdout is only reachable over SSH, and
 * it is where the story of "why did that window time out" lived until now.
 * Keeping the lines in the same database as the ledger lets the dashboard
 * page them, filter them by folder, and tail them live over the event stream
 * the run tracker already feeds.
 */
export class Log {
  private readonly db: Db;
  private readonly bus: EventBus;
  private readonly stdout: boolean;
  private readonly keep: number;
  private writes = 0;

  constructor(db: Db, bus: EventBus, opts: LogOpts = {}) {
    this.db = db;
    this.bus = bus;
    this.stdout = opts.stdout ?? false;
    this.keep = opts.keep ?? 20_000;
  }

  write(entry: LogEntry): LogLine {
    const level = entry.level ?? "info";
    const ts = new Date().toISOString();
    const { lastInsertRowid } = this.db.run(
      `INSERT INTO log_lines (ts, level, source, folder, host, message, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        ts,
        level,
        entry.source,
        entry.folder ?? null,
        entry.host ?? null,
        entry.message,
        entry.data ? JSON.stringify(entry.data) : null,
      ],
    );
    const line: LogLine = {
      id: Number(lastInsertRowid),
      ts,
      level,
      source: entry.source,
      folder: entry.folder ?? null,
      host: entry.host ?? null,
      message: entry.message,
      data: entry.data ?? null,
    };
    if (this.stdout) {
      const where = [line.folder, line.host].filter(Boolean).join("@");
      const stream = level === "info" ? process.stdout : process.stderr;
      stream.write(`${ts} ${level.padEnd(5)} ${line.source}${where ? ` ${where}` : ""}: ${line.message}\n`);
    }
    this.bus.emit({ type: "log", line });
    if (++this.writes % PRUNE_EVERY === 0) this.prune();
    return line;
  }

  info(source: LogSource, message: string, extra: Omit<LogEntry, "source" | "message" | "level"> = {}): LogLine {
    return this.write({ ...extra, source, message, level: "info" });
  }

  warn(source: LogSource, message: string, extra: Omit<LogEntry, "source" | "message" | "level"> = {}): LogLine {
    return this.write({ ...extra, source, message, level: "warn" });
  }

  error(source: LogSource, message: string, extra: Omit<LogEntry, "source" | "message" | "level"> = {}): LogLine {
    return this.write({ ...extra, source, message, level: "error" });
  }

  /** Newest first. */
  list(opts: LogListOpts = {}): LogLine[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (opts.before !== undefined) {
      where.push("id < ?");
      params.push(opts.before);
    }
    if (opts.folder) {
      where.push("folder = ?");
      params.push(opts.folder);
    }
    if (opts.level) {
      where.push("level = ?");
      params.push(opts.level);
    }
    if (opts.source) {
      where.push("source = ?");
      params.push(opts.source);
    }
    if (opts.q) {
      where.push("message LIKE ? ESCAPE '\\'");
      params.push(`%${opts.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
    const rows = this.db
      .query(
        `SELECT * FROM log_lines${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
         ORDER BY id DESC LIMIT ?`,
      )
      .all(...params, limit) as LogRow[];
    return rows.map(parseRow);
  }

  /** Drop everything older than the newest `keep` rows. */
  prune(): number {
    const { changes } = this.db.run(
      `DELETE FROM log_lines WHERE id <= (
         SELECT id FROM log_lines ORDER BY id DESC LIMIT 1 OFFSET ?
       )`,
      [this.keep],
    );
    return Number(changes);
  }
}

function parseRow(r: LogRow): LogLine {
  let data: Record<string, unknown> | null = null;
  if (r.data) {
    try {
      data = JSON.parse(r.data) as Record<string, unknown>;
    } catch {
      data = { raw: r.data };
    }
  }
  return { ...r, data };
}

/** `err.message` for Errors, String() for the rest — one place, not fifteen. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
