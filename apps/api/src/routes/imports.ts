import { Router } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadChecksums, refreshAll, refreshOne, scanRulesetImports } from "@synccenter/importers";
import type { ApiConfig } from "../config.ts";

export interface ImportsRouterDeps {
  cfg: ApiConfig;
  /** Override the importer's fetch impl (tests). */
  importerFetch?: typeof fetch;
}

export function importsRouter({ cfg, importerFetch }: ImportsRouterDeps): Router {
  const r = Router();

  r.get("/imports", (_req, res) => {
    const scan = scanRulesetImports(cfg.rulesDir);
    const checks = loadChecksums(cfg.importsDir);
    const checksMap = new Map(checks.entries.map((e) => [e.uri, e]));
    const rows = scan.imports.map((uri) => {
      const e = checksMap.get(uri);
      const cached = !!e && existsSync(join(cfg.importsDir, e.cachePath));
      return {
        uri,
        cached,
        fetchedAt: e?.fetchedAt ?? null,
        sha256: e?.sha256 ?? null,
        bytes: e?.bytes ?? null,
      };
    });
    res.json({ imports: rows, perRuleset: scan.perRuleset });
  });

  r.post("/imports/refresh", async (req, res) => {
    const force = req.query.force === "true";
    const results = await refreshAll({
      importsDir: cfg.importsDir,
      rulesetsDir: cfg.rulesDir,
      ...(importerFetch ? { fetch: importerFetch } : {}),
      force,
    });
    const anyFailed = results.some((r) => r.status.startsWith("error"));
    res.status(anyFailed ? 207 : 200).json({ results });
  });

  r.post("/imports/refresh-one", async (req, res) => {
    const uri = typeof req.query.uri === "string" ? req.query.uri : "";
    if (!uri) {
      res.status(400).json({ error: "missing ?uri parameter" });
      return;
    }
    const force = req.query.force === "true";
    const result = await refreshOne(uri, {
      importsDir: cfg.importsDir,
      rulesetsDir: cfg.rulesDir,
      ...(importerFetch ? { fetch: importerFetch } : {}),
      force,
    });
    const failed = result.status.startsWith("error");
    res.status(failed ? 502 : 200).json({ result });
  });

  return r;
}
