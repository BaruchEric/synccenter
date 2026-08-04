import { Router, type Response } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { RcloneClient, RcloneError, SyncthingError } from "@synccenter/adapters";
import { CompileError } from "@synccenter/rule-compiler";
import { loadAllHosts, PlanError, resolveBisyncAnchor } from "@synccenter/apply-planner";
import type { ApiConfig } from "../config.ts";
import type { Db } from "../db.ts";
import { listYamlNames, parseFolderByName } from "../lib/fs.ts";
import { buildFolderPlan, rcloneFilterPathForDaemon } from "../lib/plan.ts";
import { planBisyncFlags, BisyncFlagError } from "../lib/bisync-flags.ts";
import {
  applyFolder,
  createFolder,
  deleteFolder,
  setFolderEnabled,
  updateFolder,
  FolderServiceError,
} from "../lib/folders-service.ts";
import { respondJsonError } from "../lib/errors.ts";
import { HostRegistry, HostRegistryError } from "../registry.ts";
import type { EventBus, FolderAction } from "../lib/bus.ts";
import { startRun, toView } from "../lib/runs-service.ts";

export function foldersRouter(
  cfg: ApiConfig,
  registry: HostRegistry,
  db: Db,
  rclone: RcloneClient | null,
  bus: EventBus,
): Router {
  const r = Router();

  /** Tell every open dashboard that this folder moved. */
  const announce = (folder: string, action: FolderAction) =>
    bus.emit({ type: "folder", folder, action });

  r.get("/folders", (_req, res) => {
    res.json({ folders: listYamlNames(cfg.foldersDir) });
  });

  r.post("/folders", (req, res) => {
    try {
      const created = createFolder(cfg, req.body);
      announce(created.manifest.name, "created");
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

  r.put("/folders/:name", (req, res) => {
    try {
      const out = updateFolder(cfg, req.params.name, req.body);
      announce(out.manifest.name, "updated");
      res.json({ folder: out.manifest, path: out.relPath });
    } catch (err) {
      respondFolderServiceError(res, err);
    }
  });

  r.delete("/folders/:name", (req, res) => {
    // Deleting a manifest un-manages a folder that may hold the only copy of
    // real data, so it takes the same explicit confirm as apply.
    if (req.body?.confirm !== true) {
      res.status(400).json({
        error: {
          code: "CONFIRM_REQUIRED",
          message: "DELETE body must include { confirm: true }. Host folders and data are left untouched.",
        },
      });
      return;
    }
    try {
      const out = deleteFolder(cfg, req.params.name);
      announce(req.params.name, "deleted");
      res.json({ deleted: req.params.name, path: out.relPath });
    } catch (err) {
      respondFolderServiceError(res, err);
    }
  });

  for (const [suffix, enabled] of [["enable", true], ["disable", false]] as const) {
    r.post(`/folders/:name/${suffix}`, (req, res) => {
      try {
        const out = setFolderEnabled(cfg, req.params.name, enabled);
        announce(out.manifest.name, enabled ? "enabled" : "disabled");
        res.json({ folder: out.manifest, path: out.relPath });
      } catch (err) {
        respondFolderServiceError(res, err);
      }
    });
  }

  r.post("/folders/:name/pause", async (req, res) => {
    try {
      const out = await broadcast(cfg.foldersDir, req.params.name, "pause");
      announce(out.folder, "paused");
      res.json(out);
    } catch (err) {
      respondFolderError(res, err, req.params.name);
    }
  });

  r.post("/folders/:name/resume", async (req, res) => {
    try {
      const out = await broadcast(cfg.foldersDir, req.params.name, "resume");
      announce(out.folder, "resumed");
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
      announce(req.params.name, "applied");
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

    // Keyed by ruleset, not folder, and named the way the DAEMON sees it.
    const filter = rcloneFilterPathForDaemon(cfg, m);
    // Only checkable when the daemon shares our filesystem. When it does not,
    // rclone is the backstop: a filters file it cannot open aborts the run
    // outright rather than syncing unfiltered (verified against rclone 1.75).
    if (filter.local && !existsSync(filter.path)) {
      res.status(409).json({
        error: `compiled filter.rclone missing at ${filter.path}. Run POST /folders/${m.name}/apply first.`,
      });
      return;
    }

    // The scheduled crontab runs this leg with the manifest's flags; an
    // on-demand run that quietly omitted them would be a different operation
    // wearing the same name.
    let flagPlan;
    try {
      flagPlan = planBisyncFlags(m.bisync?.flags);
    } catch (err) {
      if (err instanceof BisyncFlagError) {
        res.status(400).json({ error: { code: "UNSUPPORTED_BISYNC_FLAG", message: err.message } });
        return;
      }
      throw err;
    }

    const path2 = `${member.remote}:${m.paths[memberName]}`;
    const async = req.query.async === "true";
    const dryRun = req.query.dryRun === "true";
    const resync = req.query.resync === "true";

    // Progress is only readable from a group we name ourselves — rclone's
    // `job/<jobid>` group stays empty for bisync. Unique per trigger so two
    // runs of the same folder never share a counter.
    const statsGroup = `sc/bisync/${m.name}/${crypto.randomUUID().slice(0, 8)}`;

    try {
      const out = await rclone.bisync({
        path1,
        path2,
        filtersFile: filter.path,
        statsGroup,
        ...(async ? { async: true } : {}),
        ...(dryRun ? { dryRun: true } : {}),
        ...(resync ? { resync: true } : {}),
        extra: {
          ...flagPlan.params,
          ...(Object.keys(flagPlan.config).length > 0 ? { _config: flagPlan.config } : {}),
        },
      });

      const note = `path1=${path1} path2=${path2}${async ? " async" : ""}${dryRun ? " dryRun" : ""}${resync ? " resync" : ""}`;

      if (async && typeof out.jobid === "number") {
        // Leave apply_history alone: the tracker writes the row when the job
        // actually ends, with its real result. Recording it here would put a
        // finished-looking event on the timeline for a job still running.
        const run = startRun(db, {
          folder: m.name,
          member: memberName,
          jobid: out.jobid,
          statsGroup,
          actor: "api-bearer",
          source: "api",
          dryRun,
          resync,
        });
        bus.emit({ type: "run", run: toView(run) });
        res.json({
          folder: m.name,
          path1,
          path2,
          runId: run.id,
          filtersFile: filter.path,
          ...(flagPlan.warnings.length > 0 ? { warnings: flagPlan.warnings } : {}),
          ...out,
        });
        return;
      }

      // Synchronous: it is already over by the time we get here.
      db.run(
        `INSERT INTO apply_history (ts, actor, source, target_kind, target_name, payload_hash, result, note)
         VALUES (?, 'api-bearer', 'api', 'folder', ?, ?, ?, ?)`,
        [new Date().toISOString(), m.name, "bisync", dryRun ? "dry-run" : "ok", note],
      );
      announce(m.name, "applied");
      res.json({
        folder: m.name,
        path1,
        path2,
        filtersFile: filter.path,
        ...(flagPlan.warnings.length > 0 ? { warnings: flagPlan.warnings } : {}),
        ...out,
      });
    } catch (err) {
      if (err instanceof RcloneError) {
        res.status(502).json({
          // rclone says "bisync aborted" and nothing else; the filter it was
          // told to open is the first thing worth checking.
          error: `${err.message} — rclone was asked to load ${filter.path}${
            filter.local ? "" : " (a path on the rclone host, not this one)"
          }`,
          endpoint: err.endpoint,
          upstreamStatus: err.status,
          filtersFile: filter.path,
        });
        return;
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return r;
}

/** Map a FolderServiceError onto the right status; anything else is a 500. */
function respondFolderServiceError(res: import("express").Response, err: unknown): void {
  if (err instanceof FolderServiceError) {
    const status = err.code === "NOT_FOUND" ? 404 : err.code === "NAME_TAKEN" ? 409 : 400;
    res.status(status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  respondJsonError(res, err, { knownStatus: 500 });
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
