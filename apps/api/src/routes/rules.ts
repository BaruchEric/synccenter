import { Router } from "express";
import { join } from "node:path";
import { compile, loadRuleset, CompileError } from "@synccenter/rule-compiler";
import type { ApiConfig } from "../config.ts";
import { listYamlNames } from "../lib/fs.ts";

export function rulesRouter(cfg: ApiConfig): Router {
  const r = Router();

  r.get("/rules", (_req, res) => {
    res.json({ rules: listYamlNames(cfg.rulesDir) });
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
