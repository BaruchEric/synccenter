import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { bearerAuth } from "./auth.ts";
import type { ApiConfig } from "./config.ts";
import { openDb, type Db } from "./db.ts";
import { metricsHandler } from "./metrics.ts";
import { foldersRouter } from "./routes/folders.ts";
import { rulesRouter } from "./routes/rules.ts";
import { hostsRouter } from "./routes/hosts.ts";
import { systemRouter } from "./routes/system.ts";
import { HostRegistry } from "./registry.ts";

export interface BuildAppDeps {
  cfg: ApiConfig;
  db?: Db;
  registry?: HostRegistry;
}

export interface BuiltApp {
  app: Express;
  db: Db;
  registry: HostRegistry;
}

export function buildApp({ cfg, db, registry }: BuildAppDeps): BuiltApp {
  const database = db ?? openDb(cfg.dbPath);
  const reg = registry ?? new HostRegistry({ cfg });
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  // Public — no auth.
  app.get("/health", (_req, res) => {
    res.json({ ok: true, version: "0.0.1" });
  });
  app.get("/metrics", metricsHandler);

  app.use(bearerAuth(cfg.apiToken));

  app.use("/", foldersRouter(cfg, reg, database));
  app.use("/", rulesRouter(cfg));
  app.use("/", hostsRouter(cfg, reg));
  app.use("/", systemRouter(cfg, database));

  app.use((_req, res) => res.status(404).json({ error: "not found" }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : "internal error";
    res.status(500).json({ error: message });
  });

  return { app, db: database, registry: reg };
}
