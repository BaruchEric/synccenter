import { Router } from "express";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ApiConfig } from "../config.ts";

export function hostsRouter(cfg: ApiConfig): Router {
  const r = Router();

  r.get("/hosts", (_req, res) => {
    let names: string[] = [];
    try {
      names = readdirSync(cfg.hostsDir)
        .filter((f) => f.endsWith(".yaml"))
        .map((f) => f.slice(0, -".yaml".length))
        .sort();
    } catch {
      // empty hosts dir is fine
    }
    res.json({ hosts: names });
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

  return r;
}
