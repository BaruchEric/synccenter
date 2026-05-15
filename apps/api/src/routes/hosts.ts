import { Router } from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { SyncthingError } from "@synccenter/adapters";
import type { ApiConfig } from "../config.ts";
import { HostRegistry, HostRegistryError } from "../registry.ts";

export function hostsRouter(cfg: ApiConfig, registry: HostRegistry): Router {
  const r = Router();

  r.get("/hosts", (_req, res) => {
    res.json({ hosts: registry.list() });
  });

  r.get("/hosts/:name", (req, res) => {
    const path = join(cfg.hostsDir, `${req.params.name}.yaml`);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      res.status(404).json({ error: `host not found: ${req.params.name}` });
      return;
    }
    try {
      res.json(parseYaml(raw));
    } catch (err) {
      res.status(500).json({ error: `invalid YAML in ${path}: ${(err as Error).message}` });
    }
  });

  r.get("/hosts/:name/status", async (req, res) => {
    try {
      const client = registry.client(req.params.name);
      const [version, status] = await Promise.all([client.getVersion(), client.getStatus()]);
      res.json({ host: req.params.name, online: true, version, status });
    } catch (err) {
      handleSyncthingErr(res, err, req.params.name);
    }
  });

  r.get("/hosts/:name/folders", async (req, res) => {
    try {
      const folders = await registry.client(req.params.name).listFolders();
      res.json({ host: req.params.name, folders });
    } catch (err) {
      handleSyncthingErr(res, err, req.params.name);
    }
  });

  return r;
}

function handleSyncthingErr(res: import("express").Response, err: unknown, host: string): void {
  if (err instanceof HostRegistryError) {
    res.status(err.code === "unknown-host" ? 404 : 503).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof SyncthingError) {
    res.status(502).json({
      error: err.message,
      host,
      endpoint: err.endpoint,
      upstreamStatus: err.status,
    });
    return;
  }
  res.status(500).json({ error: (err as Error).message ?? "internal error" });
}
