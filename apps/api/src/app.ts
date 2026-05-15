import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { RcloneClient } from "@synccenter/adapters";
import { bearerAuth } from "./auth.ts";
import type { ApiConfig } from "./config.ts";
import { openDb, type Db } from "./db.ts";
import { metricsHandler } from "./metrics.ts";
import { foldersRouter } from "./routes/folders.ts";
import { rulesRouter } from "./routes/rules.ts";
import { hostsRouter } from "./routes/hosts.ts";
import { rcloneRouter } from "./routes/rclone.ts";
import { systemRouter } from "./routes/system.ts";
import { HostRegistry } from "./registry.ts";

export interface BuildAppDeps {
  cfg: ApiConfig;
  db?: Db;
  registry?: HostRegistry;
  /** Optional rclone client injection. `null` to explicitly opt out of rclone routes. */
  rclone?: RcloneClient | null;
}

export interface BuiltApp {
  app: Express;
  db: Db;
  registry: HostRegistry;
  rclone: RcloneClient | null;
}

export function buildApp({ cfg, db, registry, rclone }: BuildAppDeps): BuiltApp {
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
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  // Public — no auth.
  app.get("/health", (_req, res) => {
    res.json({ ok: true, version: "0.0.1" });
  });
  app.get("/metrics", metricsHandler);

  app.use(bearerAuth(cfg.apiToken));

  app.use("/", foldersRouter(cfg, reg, database, rcloneClient));
  app.use("/", rulesRouter(cfg));
  app.use("/", hostsRouter(cfg, reg));
  app.use("/", rcloneRouter(rcloneClient));
  app.use("/", systemRouter(cfg, database));

  app.use((_req, res) => res.status(404).json({ error: "not found" }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : "internal error";
    res.status(500).json({ error: message });
  });

  return { app, db: database, registry: reg, rclone: rcloneClient };
}
