import { Router } from "express";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  loadFolderManifest,
  loadAllHosts,
  createSecretsResolver,
  plan as buildPlan,
  renderCrontab,
} from "@synccenter/apply-planner";
import type { SchedulePlan } from "@synccenter/apply-planner";
import { compile } from "@synccenter/rule-compiler";
import type { ApiConfig } from "../config.ts";

export function scheduleRouter(cfg: ApiConfig): Router {
  const router = Router();

  router.get("/schedule/crontab", async (_req, res) => {
    try {
      const hosts = loadAllHosts(cfg.hostsDir);
      const secrets = createSecretsResolver({ configDir: cfg.configDir });

      const all = readdirSync(cfg.foldersDir).filter(
        (f) => f.endsWith(".yaml") && !f.startsWith("example-") && f !== "README.md",
      );

      const allSchedule: SchedulePlan[] = [];
      for (const f of all) {
        const folder = loadFolderManifest(join(cfg.foldersDir, f));
        if (!folder.cloud) continue;
        const compiled = compile(join(cfg.rulesDir, `${folder.ruleset}.yaml`), {
          rulesetsDir: cfg.rulesDir,
          importsDir: cfg.importsDir,
        });
        const filtersFile = join(cfg.compiledDir, folder.ruleset, "filter.rclone");
        const p = buildPlan({
          folder,
          hosts,
          compiledIgnoreLines: compiled.stignore.split("\n"),
          filtersFile,
          secrets,
        });
        allSchedule.push(...p.schedule);
      }

      const text = renderCrontab(allSchedule);
      res.type("text/plain").send(text);
    } catch (err) {
      res.status(500).type("text/plain").send(`# error: ${(err as Error).message}\n`);
    }
  });

  return router;
}
