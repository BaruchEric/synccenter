import { Router } from "express";
import { join } from "node:path";
import {
  loadFolderManifest,
  loadAllHosts,
  createSecretsResolver,
  renderCrontab,
  folderHasRcloneMember,
} from "@synccenter/apply-planner";
import type { SchedulePlan } from "@synccenter/apply-planner";
import type { ApiConfig } from "../config.ts";
import { listYamlNames } from "../lib/fs.ts";
import { buildFolderPlanFor } from "../lib/plan.ts";

export function scheduleRouter(cfg: ApiConfig): Router {
  const router = Router();

  /** The same SchedulePlan the crontab is rendered from, as JSON for the UI. */
  router.get("/schedule", (_req, res) => {
    try {
      const hosts = loadAllHosts(cfg.hostsDir);
      const secrets = createSecretsResolver({ configDir: cfg.configDir });
      const names = listYamlNames(cfg.foldersDir).filter((n) => !n.startsWith("example-"));

      const jobs: SchedulePlan[] = [];
      for (const name of names) {
        const folder = loadFolderManifest(join(cfg.foldersDir, `${name}.yaml`));
        // A disabled folder keeps its manifest but contributes no cron lines.
        if (folder.enabled === false) continue;
        if (!folderHasRcloneMember(folder, hosts)) continue;
        jobs.push(...buildFolderPlanFor(cfg, folder, hosts, secrets).schedule);
      }
      res.json({ jobs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/schedule/crontab", (_req, res) => {
    try {
      const hosts = loadAllHosts(cfg.hostsDir);
      const secrets = createSecretsResolver({ configDir: cfg.configDir });
      const names = listYamlNames(cfg.foldersDir).filter((n) => !n.startsWith("example-"));

      const allSchedule: SchedulePlan[] = [];
      for (const name of names) {
        const folder = loadFolderManifest(join(cfg.foldersDir, `${name}.yaml`));
        // A disabled folder keeps its manifest but contributes no cron lines.
        if (folder.enabled === false) continue;
        if (!folderHasRcloneMember(folder, hosts)) continue;
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
