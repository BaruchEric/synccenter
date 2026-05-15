import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { bearerAuth } from "./auth.ts";
import type { ApiConfig } from "./config.ts";
import { openDb, type Db } from "./db.ts";
import { metricsHandler } from "./metrics.ts";
import { foldersRouter } from "./routes/folders.ts";
import { rulesRouter } from "./routes/rules.ts";
import { hostsRouter } from "./routes/hosts.ts";
import { systemRouter } from "./routes/system.ts";

export interface BuildAppDeps {
  cfg: ApiConfig;
  db?: Db;
}

export interface BuiltApp {
  app: Express;
  db: Db;
}

export function buildApp({ cfg, db }: BuildAppDeps): BuiltApp {
  const database = db ?? openDb(cfg.dbPath);
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  // Public endpoints — no auth.
  app.get("/health", (_req, res) => {
    res.json({ ok: true, version: "0.0.1" });
  });
  app.get("/metrics", metricsHandler);

  // Auth gate for everything below.
  app.use(bearerAuth(cfg.apiToken));

  app.use("/", foldersRouter(cfg));
  app.use("/", rulesRouter(cfg));
  app.use("/", hostsRouter(cfg));
  app.use("/", systemRouter(cfg, database));

  app.use((_req, res) => res.status(404).json({ error: "not found" }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : "internal error";
    res.status(500).json({ error: message });
  });

  return { app, db: database };
}
