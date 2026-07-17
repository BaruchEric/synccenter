import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SyncthingError } from "@synccenter/adapters";
import {
  apply as applyPlan,
  computeDelta,
  validateFolderManifest,
  type ApplyPlan,
  type ApplyResult,
  type AdapterPool,
  type DriftReport,
  type FolderManifest,
} from "@synccenter/apply-planner";
import { canonicalEmit, FOLDER_KEY_ORDER } from "@synccenter/state-importer";
import type { ApiConfig } from "../config.ts";
import type { Db } from "../db.ts";
import { listYamlNames } from "./fs.ts";
import { buildAdapterPool, buildFolderPlan } from "./plan.ts";

export type FolderServiceCode = "SCHEMA_INVALID" | "NAME_TAKEN" | "UNKNOWN_HOST" | "UNKNOWN_RULESET";

export class FolderServiceError extends Error {
  constructor(
    message: string,
    public readonly code: FolderServiceCode,
  ) {
    super(message);
    this.name = "FolderServiceError";
  }
}

export interface CreatedFolder {
  manifest: FolderManifest;
  /** Path relative to the config repo, e.g. `folders/media.yaml`. */
  relPath: string;
}

/** Folder names that collide with UI routes under /ui/jobs/ and so are refused. */
export const RESERVED_FOLDER_NAMES = new Set(["new"]);

/**
 * Validate a manifest against the schema + config repo (ruleset and hosts must
 * exist, name must be free) and write it as canonical YAML under folders/.
 */
export function createFolder(cfg: ApiConfig, value: unknown): CreatedFolder {
  const v = validateFolderManifest(value);
  if (!v.ok) throw new FolderServiceError(v.errors, "SCHEMA_INVALID");
  const manifest = v.manifest;

  if (RESERVED_FOLDER_NAMES.has(manifest.name)) {
    throw new FolderServiceError(`'${manifest.name}' is a reserved name — pick another`, "SCHEMA_INVALID");
  }

  if (!existsSync(join(cfg.rulesDir, `${manifest.ruleset}.yaml`))) {
    const known = listYamlNames(cfg.rulesDir);
    throw new FolderServiceError(
      `ruleset '${manifest.ruleset}' not found in rules/ — available: ${known.join(", ") || "(none)"}`,
      "UNKNOWN_RULESET",
    );
  }

  const knownHosts = listYamlNames(cfg.hostsDir);
  for (const host of Object.keys(manifest.paths)) {
    if (!knownHosts.includes(host)) {
      throw new FolderServiceError(
        `unknown host '${host}' — known hosts: ${knownHosts.join(", ") || "(none)"}`,
        "UNKNOWN_HOST",
      );
    }
  }

  const anchor = manifest.cloud?.anchor;
  if (anchor && !Object.keys(manifest.paths).includes(anchor)) {
    throw new FolderServiceError(
      `cloud.anchor '${anchor}' must be one of the folder's path hosts: ${Object.keys(manifest.paths).join(", ")}`,
      "UNKNOWN_HOST",
    );
  }

  const file = join(cfg.foldersDir, `${manifest.name}.yaml`);
  if (existsSync(file)) {
    throw new FolderServiceError(`folder '${manifest.name}' already exists (folders/${manifest.name}.yaml)`, "NAME_TAKEN");
  }

  const yaml = canonicalEmit(manifest, FOLDER_KEY_ORDER);
  writeFileSync(file, yaml, "utf8");
  return { manifest, relPath: `folders/${manifest.name}.yaml` };
}

export type ApplyOutcome =
  | { kind: "blocked"; code: "LIVE_ONLY" | "DIVERGENT"; details: unknown[] }
  | { kind: "done"; result: ApplyResult; delta: DriftReport };

export interface ApplyFolderOpts {
  dryRun?: boolean;
  prune?: boolean;
  force?: boolean;
  actor: string;
  source: "api" | "ui";
}

/**
 * Plan + delta-gate + apply one folder, recording apply_history.
 * Throws PlanError / CompileError / adapter errors upward; delta gates return
 * a `blocked` outcome instead of throwing so callers can offer prune/force.
 */
export async function applyFolder(cfg: ApiConfig, db: Db, name: string, opts: ApplyFolderOpts): Promise<ApplyOutcome> {
  const p = buildFolderPlan(cfg, name);
  const pool = buildAdapterPool(cfg);
  const live = await collectLiveState(p, pool);
  const delta = computeDelta(p, live as never);
  if (delta.liveOnly.length > 0 && !opts.prune) {
    return { kind: "blocked", code: "LIVE_ONLY", details: delta.liveOnly };
  }
  if (delta.divergent.length > 0 && !opts.force) {
    return { kind: "blocked", code: "DIVERGENT", details: delta.divergent };
  }
  const result = await applyPlan(p, pool, { dryRun: opts.dryRun, prune: opts.prune, force: opts.force });

  const overallOk = result.hosts.every((h) => h.status !== "failed");
  const planJson = JSON.stringify({ folder: p.folder, perHost: p.perHost });
  const payloadHash = createHash("sha256").update(planJson).digest("hex").slice(0, 16);
  db.run(
    `INSERT INTO apply_history (ts, actor, source, target_kind, target_name, payload_hash, result, note)
     VALUES (?, ?, ?, 'folder', ?, ?, ?, ?)`,
    [
      new Date().toISOString(),
      opts.actor,
      opts.source,
      p.folder,
      payloadHash,
      opts.dryRun ? "dry-run" : overallOk ? "ok" : "error",
      overallOk
        ? null
        : `failures: ${result.hosts.filter((h) => h.status === "failed").length}/${result.hosts.length}`,
    ],
  );

  return { kind: "done", result, delta };
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
    } catch (err) {
      // A real 404 means the folder isn't on this host yet. Any other failure
      // (timeout, auth, 5xx) must NOT be treated as "absent" — doing so would
      // skip the LIVE_ONLY/DIVERGENT gates below and let apply overwrite live
      // config without prune/force.
      if (!(err instanceof SyncthingError) || err.status !== 404) throw err;
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
