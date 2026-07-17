import { Router } from "express";
import { importFolder, importHost, importAll } from "@synccenter/state-importer";
import { loadAllHosts, createSecretsResolver, isRcloneHost } from "@synccenter/apply-planner";
import type { ApiConfig } from "../config.ts";
import { buildHostInfo } from "../lib/plan.ts";
import { respondJsonError } from "../lib/errors.ts";

export function stateRouter(cfg: ApiConfig): Router {
  const router = Router();

  router.post("/state/import/folder/:name", async (req, res) => {
    try {
      const result = await importFolder(req.params.name, {
        configDir: cfg.configDir,
        hosts: buildHostInfo(cfg),
        write: req.body?.write === true,
      });
      res.json({ result });
    } catch (err) {
      respondJsonError(res, err);
    }
  });

  router.post("/state/import/host/:name", async (req, res) => {
    try {
      const all = loadAllHosts(cfg.hostsDir);
      const m = all[req.params.name];
      if (!m) {
        res.status(404).json({
          error: { code: "UNKNOWN_HOST", message: `no manifest for host: ${req.params.name}` },
        });
        return;
      }
      if (isRcloneHost(m)) {
        res.status(400).json({
          error: {
            code: "NOT_SYNCTHING_HOST",
            message: `host ${m.name} is an rclone member — there is no live Syncthing state to import`,
          },
        });
        return;
      }
      const secrets = createSecretsResolver({ configDir: cfg.configDir });
      const { role, syncthing, ssh, ip, rclone } = m;
      const preserve: Record<string, unknown> = {
        role,
        syncthing,
        ...(ssh !== undefined && { ssh }),
        ...(ip !== undefined && { ip }),
        ...(rclone !== undefined && { rclone }),
      };
      const result = await importHost(
        {
          name: m.name,
          hostname: m.hostname,
          os: m.os,
          apiUrl: m.syncthing.api_url,
          apiKey: secrets.resolve(m.syncthing.api_key_ref),
          preserve,
        },
        {
          configDir: cfg.configDir,
          hosts: buildHostInfo(cfg, all, secrets),
          write: req.body?.write === true,
        },
      );
      res.json({ result });
    } catch (err) {
      respondJsonError(res, err);
    }
  });

  router.post("/state/import/all", async (req, res) => {
    try {
      const results = await importAll({
        configDir: cfg.configDir,
        hosts: buildHostInfo(cfg),
        write: req.body?.write === true,
      });
      res.json({ results });
    } catch (err) {
      respondJsonError(res, err);
    }
  });

  return router;
}
