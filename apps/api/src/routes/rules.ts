import { Router } from "express";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { compile, loadRuleset, CompileError } from "@synccenter/rule-compiler";
import type { ApiConfig } from "../config.ts";

export function rulesRouter(cfg: ApiConfig): Router {
  const r = Router();

  r.get("/rules", (_req, res) => {
    const names = listYamls(cfg.rulesDir);
    res.json({ rules: names });
  });

  r.get("/rules/:name", (req, res) => {
    try {
      const ruleset = loadRuleset(join(cfg.rulesDir, `${req.params.name}.yaml`));
      res.json(ruleset);
    } catch (err) {
      if (err instanceof CompileError && err.message.startsWith("cannot read ruleset")) {
        res.status(404).json({ error: `ruleset not found: ${req.params.name}` });
        return;
      }
      res.status(400).json({ error: (err as Error).message });
    }
  });

  r.post("/rules/:name/compile", (req, res) => {
    const allowDivergent = req.query.allowDivergent === "true";
    try {
      const result = compile(join(cfg.rulesDir, `${req.params.name}.yaml`), {
        rulesetsDir: cfg.rulesDir,
        importsDir: cfg.importsDir,
        allowDivergent,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof CompileError && err.message.startsWith("cannot read ruleset")) {
        res.status(404).json({ error: `ruleset not found: ${req.params.name}` });
        return;
      }
      res.status(400).json({ error: (err as Error).message });
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
