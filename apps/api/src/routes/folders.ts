import { Router, type Response } from "express";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { RcloneClient, RcloneError, SyncthingError } from "@synccenter/adapters";
import { RcloneClient as RcloneAdapterClient } from "@synccenter/adapters/rclone";
import { SyncthingClient } from "@synccenter/adapters/syncthing";
import {
  plan as buildPlan,
  apply as applyPlan,
  computeDelta,
  loadFolderManifest,
  loadAllHosts,
  createSecretsResolver,
  type ApplyPlan,
  type AdapterPool,
} from "@synccenter/apply-planner";
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

  r.post("/folders/:name/plan", async (req, res) => {
    try {
      const p = doBuildPlan(cfg, req.params.name);
      res.json({ plan: p });
    } catch (err) {
      res.status(400).json({
        error: {
          code: (err as { code?: string }).code ?? "INTERNAL",
          message: (err as Error).message,
        },
      });
    }
  });

  r.post("/folders/:name/apply", async (req, res) => {
    try {
      if (req.body?.confirm !== true) {
        res.status(400).json({
          error: { code: "CONFIRM_REQUIRED", message: "POST body must include { confirm: true }" },
        });
        return;
      }
      const { dryRun, prune, force } = req.body ?? {};
      const p = doBuildPlan(cfg, req.params.name);
      const pool = doBuildAdapterPool(cfg);
      const live = await collectLiveState(p, pool);
      const delta = computeDelta(p, live as never);
      if (delta.liveOnly.length > 0 && !prune) {
        res.status(409).json({
          error: {
            code: "LIVE_ONLY",
            message: "pass prune:true to apply",
            details: delta.liveOnly,
          },
        });
        return;
      }
      if (delta.divergent.length > 0 && !force) {
        res.status(409).json({
          error: {
            code: "DIVERGENT",
            message: "pass force:true to apply",
            details: delta.divergent,
          },
        });
        return;
      }
      const result = await applyPlan(p, pool, { dryRun, prune, force });

      // Record history for auditability.
      const overallOk = result.hosts.every((h) => h.status !== "failed");
      const planJson = JSON.stringify({ folder: p.folder, perHost: p.perHost });
      const payloadHash = createHash("sha256").update(planJson).digest("hex").slice(0, 16);
      db.run(
        `INSERT INTO apply_history (ts, actor, source, target_kind, target_name, payload_hash, result, note)
         VALUES (?, ?, 'api', 'folder', ?, ?, ?, ?)`,
        [
          new Date().toISOString(),
          "api-bearer",
          p.folder,
          payloadHash,
          overallOk ? "ok" : "error",
          overallOk
            ? null
            : `failures: ${result.hosts.filter((h) => h.status === "failed").length}/${result.hosts.length}`,
        ],
      );

      res.json({ result, delta });
    } catch (err) {
      if (err instanceof CompileError) {
        res.status(400).json({ error: { code: "COMPILE_ERROR", message: err.message } });
        return;
      }
      res.status(500).json({
        error: {
          code: (err as { code?: string }).code ?? "INTERNAL",
          message: (err as Error).message,
        },
      });
    }
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

function doBuildPlan(cfg: ApiConfig, name: string): ApplyPlan {
  const folder = loadFolderManifest(join(cfg.foldersDir, `${name}.yaml`));
  const hosts = loadAllHosts(cfg.hostsDir);
  const secrets = createSecretsResolver({ configDir: cfg.configDir });
  const compiled = compile(join(cfg.rulesDir, `${folder.ruleset}.yaml`), {
    rulesetsDir: cfg.rulesDir,
    importsDir: cfg.importsDir,
  });
  const ignoreLines = compiled.stignore.split("\n").filter((l) => l && !l.startsWith("#"));
  const filtersFile = join(cfg.compiledDir, folder.ruleset, "filter.rclone");
  return buildPlan({ folder, hosts, compiledIgnoreLines: ignoreLines, filtersFile, secrets });
}

function doBuildAdapterPool(cfg: ApiConfig): AdapterPool {
  const hosts = loadAllHosts(cfg.hostsDir);
  const secrets = createSecretsResolver({ configDir: cfg.configDir });
  return {
    syncthing: (h: string) => {
      const host = hosts[h];
      if (!host) throw new Error(`unknown host: ${h}`);
      return new SyncthingClient({
        baseUrl: host.syncthing.api_url,
        apiKey: secrets.resolve(host.syncthing.api_key_ref),
      });
    },
    rclone: (h: string) => {
      const host = hosts[h];
      if (!host) throw new Error(`unknown host: ${h}`);
      if (!host.rclone) throw new Error(`host ${h} has no rclone block`);
      const auth = secrets.resolve(host.rclone.auth_ref);
      const ci = auth.indexOf(":");
      if (ci > 0) {
        return new RcloneAdapterClient({
          baseUrl: host.rclone.rcd_url,
          username: auth.slice(0, ci),
          password: auth.slice(ci + 1),
        });
      }
      return new RcloneAdapterClient({ baseUrl: host.rclone.rcd_url, bearerToken: auth });
    },
  };
}

async function collectLiveState(
  p: ApplyPlan,
  pool: AdapterPool,
): Promise<Record<string, { folder: unknown; ignores: unknown }>> {
  const out: Record<string, { folder: unknown; ignores: unknown }> = {};
  for (const host of Object.keys(p.perHost)) {
    const c = pool.syncthing(host);
    let folder: unknown = null;
    let ignores: unknown = null;
    try {
      folder = await c.getFolder(p.folder);
    } catch {
      // 404 — folder doesn't exist on this host yet.
    }
    if (folder) {
      try {
        const ig = await c.getIgnores(p.folder);
        ignores = ig.ignore ?? [];
      } catch {
        ignores = [];
      }
      // Bridge: planner type requires label; adapter type doesn't.
      const f = folder as { id: string; label?: string };
      if (f.label === undefined) f.label = f.id;
    }
    out[host] = { folder, ignores };
  }
  return out;
}
