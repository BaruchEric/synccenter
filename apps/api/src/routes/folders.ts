import { Router } from "express";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ApiConfig } from "../config.ts";

export function foldersRouter(cfg: ApiConfig): Router {
  const r = Router();

  r.get("/folders", (_req, res) => {
    const names = listYamls(cfg.foldersDir);
    res.json({ folders: names });
  });

  r.get("/folders/:name", (req, res) => {
    const path = join(cfg.foldersDir, `${req.params.name}.yaml`);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      res.status(404).json({ error: `folder not found: ${req.params.name}` });
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

function listYamls(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".yaml"))
      .map((f) => f.slice(0, -".yaml".length))
      .sort();
  } catch {
    return [];
  }
}
