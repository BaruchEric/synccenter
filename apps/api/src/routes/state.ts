import { Router } from "express";
import {
  importFolder,
  importHost,
  importAll,
  type HostInfo,
} from "@synccenter/state-importer";
import { loadAllHosts, createSecretsResolver } from "@synccenter/apply-planner";
import type { ApiConfig } from "../config.ts";

export function stateRouter(cfg: ApiConfig): Router {
  const router = Router();

  function buildHostInfo(): HostInfo[] {
    const all = loadAllHosts(cfg.hostsDir);
    const secrets = createSecretsResolver({ configDir: cfg.configDir });
    return Object.values(all).map((h) => ({
      name: h.name,
      apiUrl: h.syncthing.api_url,
      apiKey: secrets.resolve(h.syncthing.api_key_ref),
    }));
  }

  router.post("/state/import/folder/:name", async (req, res) => {
    try {
      const result = await importFolder(req.params.name, {
        configDir: cfg.configDir,
        hosts: buildHostInfo(),
        write: req.body?.write === true,
      });
      res.json({ result });
    } catch (err) {
      res.status(400).json({
        error: {
          code: (err as { code?: string }).code ?? "INTERNAL",
          message: (err as Error).message,
        },
      });
    }
  });

  router.post("/state/import/host/:name", async (req, res) => {
    try {
      const all = loadAllHosts(cfg.hostsDir);
      const m = all[req.params.name];
      if (!m) {
        res.status(404).json({
          error: {
            code: "UNKNOWN_HOST",
            message: `no manifest for host: ${req.params.name}`,
          },
        });
        return;
      }
      const secrets = createSecretsResolver({ configDir: cfg.configDir });
      const preserve: Record<string, unknown> = {
        role: m.role,
        syncthing: m.syncthing,
      };
      if (m.ssh !== undefined) preserve.ssh = m.ssh;
      if (m.ip !== undefined) preserve.ip = m.ip;
      if (m.rclone !== undefined) preserve.rclone = m.rclone;
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
          hosts: buildHostInfo(),
          write: req.body?.write === true,
        },
      );
      res.json({ result });
    } catch (err) {
      res.status(400).json({
        error: {
          code: (err as { code?: string }).code ?? "INTERNAL",
          message: (err as Error).message,
        },
      });
    }
  });

  router.post("/state/import/all", async (req, res) => {
    try {
      const results = await importAll({
        configDir: cfg.configDir,
        hosts: buildHostInfo(),
        write: req.body?.write === true,
      });
      res.json({ results });
    } catch (err) {
      res.status(400).json({
        error: {
          code: (err as { code?: string }).code ?? "INTERNAL",
          message: (err as Error).message,
        },
      });
    }
  });

  return router;
}
