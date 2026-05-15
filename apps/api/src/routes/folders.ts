import { Router, type Response } from "express";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { SyncthingError } from "@synccenter/adapters";
import { compile, CompileError } from "@synccenter/rule-compiler";
import type { ApiConfig } from "../config.ts";
import type { Db } from "../db.ts";
import { HostRegistry, HostRegistryError } from "../registry.ts";

interface FolderManifest {
  name: string;
  ruleset: string;
  type: string;
  paths: Record<string, string>;
}

export function foldersRouter(cfg: ApiConfig, registry: HostRegistry, db: Db): Router {
  const r = Router();

  r.get("/folders", (_req, res) => {
    const names = listYamls(cfg.foldersDir);
    res.json({ folders: names });
  });

  r.get("/folders/:name", (req, res) => {
    const m = loadFolder(cfg.foldersDir, req.params.name);
    if (!m) {
      res.status(404).json({ error: `folder not found: ${req.params.name}` });
      return;
    }
    res.json(m);
  });

  r.get("/folders/:name/state", async (req, res) => {
    const m = loadFolder(cfg.foldersDir, req.params.name);
    if (!m) {
      res.status(404).json({ error: `folder not found: ${req.params.name}` });
      return;
    }
    const hosts = Object.keys(m.paths);
    const perHost = await Promise.all(
      hosts.map(async (host) => {
        try {
          const status = await registry.client(host).getFolderStatus(m.name);
          return { host, ok: true as const, status };
        } catch (err) {
          return { host, ok: false as const, error: errorMessage(err) };
        }
      }),
    );
    res.json({ folder: m.name, perHost });
  });

  const broadcast = async (
    foldersDir: string,
    name: string,
    op: "pause" | "resume",
  ): Promise<{ folder: string; perHost: Array<{ host: string; ok: boolean; error?: string }> }> => {
    const m = loadFolder(foldersDir, name);
    if (!m) throw new HostRegistryError(`folder not found: ${name}`, "unknown-host");
    const hosts = Object.keys(m.paths);
    const results = await Promise.all(
      hosts.map(async (host) => {
        try {
          const c = registry.client(host);
          if (op === "pause") await c.pauseFolder(m.name);
          else await c.resumeFolder(m.name);
          return { host, ok: true };
        } catch (err) {
          return { host, ok: false, error: errorMessage(err) };
        }
      }),
    );
    return { folder: m.name, perHost: results };
  };

  r.post("/folders/:name/pause", async (req, res) => {
    try {
      const out = await broadcast(cfg.foldersDir, req.params.name, "pause");
      res.json(out);
    } catch (err) {
      respondFolderError(res, err, req.params.name);
    }
  });

  r.post("/folders/:name/resume", async (req, res) => {
    try {
      const out = await broadcast(cfg.foldersDir, req.params.name, "resume");
      res.json(out);
    } catch (err) {
      respondFolderError(res, err, req.params.name);
    }
  });

  r.post("/folders/:name/apply", async (req, res) => {
    const dryRun = req.query.dryRun === "true";
    const m = loadFolder(cfg.foldersDir, req.params.name);
    if (!m) {
      res.status(404).json({ error: `folder not found: ${req.params.name}` });
      return;
    }

    let compiled;
    try {
      compiled = compile(join(cfg.rulesDir, `${m.ruleset}.yaml`), {
        rulesetsDir: cfg.rulesDir,
        importsDir: cfg.importsDir,
        allowDivergent: req.query.allowDivergent === "true",
      });
    } catch (err) {
      if (err instanceof CompileError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const ignoreLines = compiled.stignore.split("\n").filter((l) => l.length > 0);
    const payloadHash = createHash("sha256").update(compiled.stignore).digest("hex").slice(0, 16);

    if (dryRun) {
      res.json({
        folder: m.name,
        dryRun: true,
        hosts: Object.keys(m.paths),
        stignorePreview: compiled.stignore,
        rclonePreview: compiled.rcloneFilter,
        warnings: compiled.warnings,
        payloadHash,
      });
      return;
    }

    const hosts = Object.keys(m.paths);
    const perHost = await Promise.all(
      hosts.map(async (host) => {
        try {
          const c = registry.client(host);
          await c.setIgnores(m.name, ignoreLines);
          await c.scan(m.name);
          return { host, ok: true as const };
        } catch (err) {
          return { host, ok: false as const, error: errorMessage(err) };
        }
      }),
    );

    const overallOk = perHost.every((p) => p.ok);
    db.run(
      `INSERT INTO apply_history (ts, actor, source, target_kind, target_name, payload_hash, result, note)
       VALUES (?, ?, 'api', 'folder', ?, ?, ?, ?)`,
      [
        new Date().toISOString(),
        "api-bearer",
        m.name,
        payloadHash,
        overallOk ? "ok" : "error",
        overallOk ? null : `failures: ${perHost.filter((p) => !p.ok).length}/${perHost.length}`,
      ],
    );

    res.status(overallOk ? 200 : 207).json({
      folder: m.name,
      dryRun: false,
      payloadHash,
      perHost,
      warnings: compiled.warnings,
    });
  });

  return r;
}

function loadFolder(foldersDir: string, name: string): FolderManifest | undefined {
  const path = join(foldersDir, `${name}.yaml`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    return parseYaml(raw) as FolderManifest;
  } catch {
    return undefined;
  }
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

function errorMessage(err: unknown): string {
  if (err instanceof SyncthingError) {
    return `${err.message}${err.status ? ` (HTTP ${err.status})` : ""}`;
  }
  if (err instanceof HostRegistryError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

function respondFolderError(res: Response, err: unknown, name: string): void {
  if (err instanceof HostRegistryError && err.code === "unknown-host") {
    res.status(404).json({ error: `folder not found: ${name}` });
    return;
  }
  res.status(500).json({ error: errorMessage(err) });
}
