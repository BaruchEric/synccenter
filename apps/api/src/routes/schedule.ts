import { Router } from "express";
import { join } from "node:path";
import {
  loadFolderManifest,
  loadAllHosts,
  createSecretsResolver,
  renderCrontab,
} from "@synccenter/apply-planner";
import type { SchedulePlan } from "@synccenter/apply-planner";
import type { ApiConfig } from "../config.ts";
import { listYamlNames } from "../lib/fs.ts";
import { buildFolderPlanFor } from "../lib/plan.ts";

export function scheduleRouter(cfg: ApiConfig): Router {
  const router = Router();

  router.get("/schedule/crontab", (_req, res) => {
    try {
      const hosts = loadAllHosts(cfg.hostsDir);
      const secrets = createSecretsResolver({ configDir: cfg.configDir });
      const names = listYamlNames(cfg.foldersDir).filter((n) => !n.startsWith("example-"));

      const allSchedule: SchedulePlan[] = [];
      for (const name of names) {
        const folder = loadFolderManifest(join(cfg.foldersDir, `${name}.yaml`));
        if (!folder.cloud) continue;
        const p = buildFolderPlanFor(cfg, folder, hosts, secrets);
        allSchedule.push(...p.schedule);
      }

      res.type("text/plain").send(renderCrontab(allSchedule));
    } catch (err) {
      res.status(500).type("text/plain").send(`# error: ${(err as Error).message}\n`);
    }
  });

  return router;
}
