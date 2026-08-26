import { Router, type Response } from "express";
import { RcloneClient, SyncthingError } from "@synccenter/adapters";
import { CompileError } from "@synccenter/rule-compiler";
import { effectiveSync } from "@synccenter/apply-planner";
import type { ApiConfig } from "../config.ts";
import type { Db } from "../db.ts";
import { listYamlNames, parseFolderByName } from "../lib/fs.ts";
import { buildFolderPlan } from "../lib/plan.ts";
import { BisyncStartError, startBisync } from "../lib/bisync-service.ts";
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
import type { Log } from "../lib/log.ts";
import { SyncNow, SyncNowError } from "../lib/sync-now.ts";
import type { SyncWindowEngine } from "../lib/sync-windows.ts";

export function foldersRouter(
  cfg: ApiConfig,
  registry: HostRegistry,
  db: Db,
  rclone: RcloneClient | null,
  bus: EventBus,
  engine: SyncWindowEngine,
  log: Log,
  syncNow: SyncNow,
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
      log.info("folder", `folder created (${created.relPath})`, { folder: created.manifest.name });
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
        // The mode explains the state: a scheduled member reading `paused` is
        // resting between windows, not stuck — the UI needs to know which.
        const mode = effectiveSync(m, host).mode;
        try {
          const status = await registry.client(host).getFolderStatus(m.name);
          return { host, mode, ok: true as const, status };
        } catch (err) {
          return { host, mode, ok: false as const, error: errorMessage(err) };
        }
      }),
    );
    res.json({ folder: m.name, perHost });
  });

  /**
   * What each Syncthing member cannot pull for this folder, and why. This is
   * the detail behind a non-zero `errors` count in /state — the thing that
   * keeps a window from ever closing as done.
   */
  r.get("/folders/:name/errors", async (req, res) => {
    const m = parseFolderByName(cfg.foldersDir, req.params.name);
    if (!m) {
      res.status(404).json({ error: `folder not found: ${req.params.name}` });
      return;
    }
    const perHost = await Promise.all(
      syncthingHosts(m).map(async (host) => {
        try {
          const out = await registry.client(host).getFolderErrors(m.name);
          return { host, ok: true as const, errors: out.errors ?? [] };
        } catch (err) {
          return { host, ok: false as const, errors: [], error: errorMessage(err) };
        }
      }),
    );
    res.json({ folder: m.name, perHost });
  });

  /**
   * Sync now, every leg: open a window on the held (scheduled/manual)
   * Syncthing members — `?host=` narrows it to one — and once those windows
   * close, run the bisync to every rclone member. `?cloud=false` stops after
   * the windows. A folder with no held member but a cloud member goes
   * straight to the bisync.
   */
  r.post("/folders/:name/sync", async (req, res) => {
    try {
      const out = await syncNow.run(req.params.name, {
        ...(typeof req.query.host === "string" ? { host: req.query.host } : {}),
        cloud: req.query.cloud !== "false",
        actor: "api-bearer",
        source: "api",
      });
      const somethingHappened =
        out.windows.length > 0 || out.cloud?.status === "queued" || (out.cloud?.status === "started" && out.cloud.runs.length > 0);
      if (somethingHappened) {
        res.json(out);
        return;
      }
      // Nothing started. The clients read `error` and nothing else on a
      // non-2xx, so the reasons have to be there too, or the operator gets
      // "500 Internal Server Error" for a folder whose filters were never
      // compiled. The full result stays in the body for anyone who wants it.
      const why = [
        ...out.failed.map((f) => `${f.host}: ${f.error}`),
        ...(out.cloud?.status === "started" ? out.cloud.errors.map((e) => `${e.member}: ${e.error}`) : []),
      ];
      res.status(500).json({
        error: `sync now started nothing for ${out.folder} (job #${out.job.id})${why.length > 0 ? `: ${why.join("; ")}` : ""}`,
        ...out,
      });
    } catch (err) {
      if (err instanceof SyncNowError) {
        res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
        return;
      }
      res.status(500).json({ error: errorMessage(err) });
    }
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
    const failed = results.filter((x) => !x.ok);
    log.write({
      level: failed.length === 0 ? "info" : "warn",
      source: "folder",
      folder: m.name,
      message:
        failed.length === 0
          ? `${op === "pause" ? "paused" : "resumed"} on ${results.map((x) => x.host).join(", ") || "no host"}`
          : `${op} failed on ${failed.map((x) => `${x.host} (${x.error})`).join(", ")}`,
      data: { op, perHost: results },
    });
    return { folder: m.name, perHost: results };
  };

  r.put("/folders/:name", (req, res) => {
    try {
      const out = updateFolder(cfg, req.params.name, req.body);
      announce(out.manifest.name, "updated");
      log.info("folder", `manifest updated (${out.relPath})`, { folder: out.manifest.name });
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
      log.warn("folder", `manifest deleted (${out.relPath}); host folders and data left untouched`, {
        folder: req.params.name,
      });
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
        log.info("folder", enabled ? "enabled — schedules apply again" : "disabled — no scheduled runs until re-enabled", {
          folder: out.manifest.name,
        });
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
        log,
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
      // Apply creates folders unpaused; held members must not stay live until
      // the next reconcile interval happens to notice.
      void engine.reconcile();
      res.json({ result: outcome.result, delta: outcome.delta });
    } catch (err) {
      if (err instanceof CompileError) {
        log.error("apply", `apply refused: ${err.message}`, { folder: req.params.name });
        res.status(400).json({ error: { code: "COMPILE_ERROR", message: err.message } });
        return;
      }
      log.error("apply", `apply failed: ${errorMessage(err)}`, { folder: req.params.name });
      respondJsonError(res, err);
    }
  });

  r.post("/folders/:name/bisync", async (req, res) => {
    try {
      const started = await startBisync(
        { cfg, db, registry, rclone, bus, log },
        req.params.name,
        {
          ...(typeof req.query.member === "string" ? { member: req.query.member } : {}),
          async: req.query.async === "true",
          dryRun: req.query.dryRun === "true",
          resync: req.query.resync === "true",
          actor: "api-bearer",
          source: "api",
        },
      );
      const { out, run, ...rest } = started;
      res.json({ ...rest, ...(run ? { runId: run.id } : {}), ...out });
    } catch (err) {
      if (err instanceof BisyncStartError) {
        res.status(err.status).json(err.body);
        return;
      }
      res.status(500).json({ error: errorMessage(err) });
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
