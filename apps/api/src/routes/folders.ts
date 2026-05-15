import { Router, type Response } from "express";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { RcloneClient, RcloneError, SyncthingError } from "@synccenter/adapters";
import { compile, CompileError } from "@synccenter/rule-compiler";
import type { ApiConfig } from "../config.ts";
import type { Db } from "../db.ts";
import { listYamlNames, parseFolderByName } from "../lib/fs.ts";
import { HostRegistry, HostRegistryError } from "../registry.ts";

export function foldersRouter(
  cfg: ApiConfig,
  registry: HostRegistry,
  db: Db,
  rclone: RcloneClient | null,
): Router {
  const r = Router();

  r.get("/folders", (_req, res) => {
    res.json({ folders: listYamlNames(cfg.foldersDir) });
  });

  r.get("/folders/:name", (req, res) => {
    const m = parseFolderByName(cfg.foldersDir,req.params.name);
    if (!m) {
      res.status(404).json({ error: `folder not found: ${req.params.name}` });
      return;
    }
    res.json(m);
  });

  r.get("/folders/:name/state", async (req, res) => {
    const m = parseFolderByName(cfg.foldersDir,req.params.name);
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
    const m = parseFolderByName(foldersDir, name);
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
    const m = parseFolderByName(cfg.foldersDir,req.params.name);
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

  r.post("/folders/:name/bisync", async (req, res) => {
    if (!rclone) {
      res.status(503).json({ error: "rclone is not configured (set SC_RCLONE_URL)" });
      return;
    }
    const m = parseFolderByName(cfg.foldersDir,req.params.name);
    if (!m) {
      res.status(404).json({ error: `folder not found: ${req.params.name}` });
      return;
    }
    if (!m.cloud) {
      res.status(400).json({ error: `folder ${m.name} has no cloud edge configured` });
      return;
    }

    // Find the cloud-edge host — the path on this host is the rcd-local path1.
    const cloudHostName = registry.list().find((h) => registry.manifest(h)?.role === "cloud-edge");
    if (!cloudHostName) {
      res.status(400).json({ error: "no host with role=cloud-edge is registered" });
      return;
    }
    const path1 = m.paths[cloudHostName];
    if (!path1) {
      res
        .status(400)
        .json({ error: `folder ${m.name} has no path entry for cloud-edge host ${cloudHostName}` });
      return;
    }

    const filterPath = join(cfg.compiledDir, m.name, "filter.rclone");
    const filterExists = existsSync(filterPath);
    if (!filterExists) {
      res.status(409).json({
        error: `compiled filter.rclone missing at ${filterPath}. Run POST /folders/${m.name}/apply first.`,
      });
      return;
    }

    const path2 = `${m.cloud.rclone_remote}:${m.cloud.remote_path}`;
    const async = req.query.async === "true";
    const dryRun = req.query.dryRun === "true";
    const resync = req.query.resync === "true";

    try {
      const out = await rclone.bisync({
        path1,
        path2,
        filtersFile: filterPath,
        ...(async ? { async: true } : {}),
        ...(dryRun ? { dryRun: true } : {}),
        ...(resync ? { resync: true } : {}),
      });
      db.run(
        `INSERT INTO apply_history (ts, actor, source, target_kind, target_name, payload_hash, result, note)
         VALUES (?, 'api-bearer', 'api', 'folder', ?, ?, 'ok', ?)`,
        [
          new Date().toISOString(),
          m.name,
          "bisync-trigger",
          `path1=${path1} path2=${path2}${async ? " async" : ""}${dryRun ? " dryRun" : ""}${resync ? " resync" : ""}`,
        ],
      );
      res.json({ folder: m.name, path1, path2, ...out });
    } catch (err) {
      if (err instanceof RcloneError) {
        res.status(502).json({
          error: err.message,
          endpoint: err.endpoint,
          upstreamStatus: err.status,
        });
        return;
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return r;
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
