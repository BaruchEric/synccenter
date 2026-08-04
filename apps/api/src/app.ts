import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { RcloneClient } from "@synccenter/adapters";
import { version as PKG_VERSION } from "../package.json" with { type: "json" };
import { bearerAuth } from "./auth.ts";
import type { ApiConfig } from "./config.ts";
import { openDb, type Db } from "./db.ts";
import { EventBus } from "./lib/bus.ts";
import { RunTracker } from "./lib/run-tracker.ts";
import { abandonStaleRuns } from "./lib/runs-service.ts";
import { metricsHandlerFactory } from "./metrics.ts";
import { foldersRouter } from "./routes/folders.ts";
import { rulesRouter } from "./routes/rules.ts";
import { hostsRouter } from "./routes/hosts.ts";
import { importsRouter } from "./routes/imports.ts";
import { rcloneRouter } from "./routes/rclone.ts";
import { runsRouter } from "./routes/runs.ts";
import { eventsRouter } from "./routes/events.ts";
import { scheduleRouter } from "./routes/schedule.ts";
import { stateRouter } from "./routes/state.ts";
import { systemRouter } from "./routes/system.ts";
import { uiRouter } from "./ui/router.ts";
import { HostRegistry } from "./registry.ts";

export interface BuildAppDeps {
  cfg: ApiConfig;
  db?: Db;
  registry?: HostRegistry;
  /** Optional rclone client injection. `null` to explicitly opt out of rclone routes. */
  rclone?: RcloneClient | null;
  /** Injectable fetch for the gitignore-importer (tests). */
  importerFetch?: typeof fetch;
}

export interface BuiltApp {
  app: Express;
  db: Db;
  registry: HostRegistry;
  rclone: RcloneClient | null;
  bus: EventBus;
  /**
   * Polls in-flight bisync jobs. Deliberately NOT started here — call
   * `tracker.start()` from the server entrypoint. Leaving it stopped keeps an
   * interval out of every test that builds an app.
   */
  tracker: RunTracker;
}

export function buildApp({ cfg, db, registry, rclone, importerFetch }: BuildAppDeps): BuiltApp {
  const database = db ?? openDb(cfg.dbPath);
  const reg = registry ?? new HostRegistry({ cfg });
  const rcloneClient =
    rclone === undefined
      ? cfg.rclone
        ? new RcloneClient({
            baseUrl: cfg.rclone.url,
            ...(cfg.rclone.username ? { username: cfg.rclone.username } : {}),
            ...(cfg.rclone.password ? { password: cfg.rclone.password } : {}),
            ...(cfg.rclone.bearerToken ? { bearerToken: cfg.rclone.bearerToken } : {}),
          })
        : null
      : rclone;
  const bus = new EventBus();
  // Job ids do not survive a restart of either process, so any run still marked
  // running belongs to a job we can no longer identify. Close them out rather
  // than polling ids that may since have been handed to something else.
  abandonStaleRuns(database);
  const tracker = new RunTracker({ db: database, bus, rclone: rcloneClient });
  tracker.onFinished = (run) => {
    database.run(
      `INSERT INTO apply_history (ts, actor, source, target_kind, target_name, payload_hash, result, note)
       VALUES (?, ?, ?, 'folder', ?, 'bisync', ?, ?)`,
      [
        run.finished_at ?? new Date().toISOString(),
        run.actor,
        run.source,
        run.folder,
        run.dry_run ? "dry-run" : run.state === "done" ? "ok" : "error",
        run.state === "done"
          ? `bisync → ${run.member ?? "?"} · ${size(run.bytes)} in ${elapsed(run.started_at, run.finished_at)}`
          : (run.error ?? `bisync ${run.state}`),
      ],
    );
    bus.emit({ type: "folder", folder: run.folder, action: "applied" });
  };

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  // Public — no auth.
  app.get("/health", (_req, res) => {
    res.json({ ok: true, version: PKG_VERSION });
  });
  app.get("/metrics", metricsHandlerFactory(cfg, reg, database));

  // Server-rendered HTMX console — cookie session auth, scoped to /ui.
  app.get("/", (_req, res) => res.redirect("/ui/jobs"));
  app.use("/ui", uiRouter({ cfg, registry: reg, db: database, rclone: rcloneClient }));

  app.use(bearerAuth(cfg.apiToken));

  app.use("/", foldersRouter(cfg, reg, database, rcloneClient, bus));
  app.use("/", runsRouter(database, bus, rcloneClient));
  app.use("/", eventsRouter(database, bus));
  app.use("/", rulesRouter(cfg));
  app.use("/", hostsRouter(cfg, reg));
  app.use("/", rcloneRouter(rcloneClient));
  app.use("/", importsRouter({ cfg, ...(importerFetch ? { importerFetch } : {}) }));
  app.use("/", stateRouter(cfg));
  app.use("/", scheduleRouter(cfg));
  app.use("/", systemRouter(database));

  app.use((_req, res) => res.status(404).json({ error: "not found" }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : "internal error";
    res.status(500).json({ error: message });
  });

  return { app, db: database, registry: reg, rclone: rcloneClient, bus, tracker };
}

/** Human-readable byte count for the history note. */
function size(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v.toFixed(i === 0 || v >= 100 ? 0 : 1)} ${units[i]}`;
}

/** Human-readable run duration for the history note. */
function elapsed(from: string, to: string | null): string {
  const ms = new Date(to ?? Date.now()).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
