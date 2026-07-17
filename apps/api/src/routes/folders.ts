import { Router, type Response } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { RcloneClient, RcloneError, SyncthingError } from "@synccenter/adapters";
import { CompileError } from "@synccenter/rule-compiler";
import { loadAllHosts, PlanError, resolveBisyncAnchor } from "@synccenter/apply-planner";
import type { ApiConfig } from "../config.ts";
import type { Db } from "../db.ts";
import { listYamlNames, parseFolderByName } from "../lib/fs.ts";
import { buildFolderPlan } from "../lib/plan.ts";
import { applyFolder, createFolder, FolderServiceError } from "../lib/folders-service.ts";
import { respondJsonError } from "../lib/errors.ts";
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

  r.post("/folders", (req, res) => {
    try {
      const created = createFolder(cfg, req.body);
      res.status(201).json({ folder: created.manifest, path: created.relPath });
    } catch (err) {
      if (err instanceof FolderServiceError) {
        res
          .status(err.code === "NAME_TAKEN" ? 409 : 400)
          .json({ error: { code: err.code, message: err.message } });
        return;
      }
      // Anything else here (e.g. a filesystem write fault, which carries a
      // `code` like EACCES) is a server fault, not a client error — 500, not 400.
      respondJsonError(res, err, { knownStatus: 500 });
    }
  });

  r.get("/folders/:name", (req, res) => {
    const m = parseFolderByName(cfg.foldersDir,req.params.name);
    if (!m) {
      res.status(404).json({ error: `folder not found: ${req.params.name}` });
      return;
    }
    res.json(m);
  });

  /** Syncthing members of a folder — rclone members have no daemon to talk to. */
  const syncthingHosts = (m: { paths: Record<string, string> }): string[] =>
    Object.keys(m.paths).filter((h) => !registry.isRclone(h));

  r.get("/folders/:name/state", async (req, res) => {
    const m = parseFolderByName(cfg.foldersDir,req.params.name);
    if (!m) {
      res.status(404).json({ error: `folder not found: ${req.params.name}` });
      return;
    }
    const hosts = syncthingHosts(m);
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
    const hosts = syncthingHosts(m);
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
      const p = buildFolderPlan(cfg, req.params.name);
      res.json({ plan: p });
    } catch (err) {
      respondJsonError(res, err);
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
      const outcome = await applyFolder(cfg, db, req.params.name, {
        dryRun,
        prune,
        force,
        actor: "api-bearer",
        source: "api",
      });
      if (outcome.kind === "blocked") {
        res.status(409).json({
          error: {
            code: outcome.code,
            message: outcome.code === "LIVE_ONLY" ? "pass prune:true to apply" : "pass force:true to apply",
            details: outcome.details,
          },
        });
        return;
      }
      res.json({ result: outcome.result, delta: outcome.delta });
    } catch (err) {
      if (err instanceof CompileError) {
        res.status(400).json({ error: { code: "COMPILE_ERROR", message: err.message } });
        return;
      }
      respondJsonError(res, err);
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
    // rclone members of this folder — engine: rclone hosts appearing in paths.
    const rcloneMembers = Object.keys(m.paths).filter((h) => registry.isRclone(h));
    if (rcloneMembers.length === 0) {
      res.status(400).json({ error: `folder ${m.name} has no rclone member in paths` });
      return;
    }
    const memberName = typeof req.query.member === "string" ? req.query.member : rcloneMembers[0]!;
    if (!rcloneMembers.includes(memberName)) {
      res.status(400).json({
        error: `'${memberName}' is not an rclone member of folder ${m.name} — members: ${rcloneMembers.join(", ")}`,
      });
      return;
    }
    const member = registry.manifest(memberName)!;
    if (!member.remote) {
      res.status(500).json({ error: `host ${memberName} has engine: rclone but no remote` });
      return;
    }

    // Find the anchor host — the path on this host is the rcd-local path1.
    // Same resolution rules (and errors) as the planner's schedule step.
    let anchorName: string;
    try {
      anchorName = resolveBisyncAnchor(m, loadAllHosts(cfg.hostsDir)).name;
    } catch (err) {
      res.status(err instanceof PlanError ? 400 : 500).json({ error: errorMessage(err) });
      return;
    }
    const path1 = m.paths[anchorName]!; // resolver guarantees the anchor is in paths

    const filterPath = join(cfg.compiledDir, m.name, "filter.rclone");
    const filterExists = existsSync(filterPath);
    if (!filterExists) {
      res.status(409).json({
        error: `compiled filter.rclone missing at ${filterPath}. Run POST /folders/${m.name}/apply first.`,
      });
      return;
    }

    const path2 = `${member.remote}:${m.paths[memberName]}`;
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
         VALUES (?, 'api-bearer', 'api', 'folder', ?, ?, ?, ?)`,
        [
          new Date().toISOString(),
          m.name,
          "bisync-trigger",
          dryRun ? "dry-run" : "ok",
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
