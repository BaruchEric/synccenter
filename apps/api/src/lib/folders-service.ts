import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, parseDocument, isMap } from "yaml";
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

export type FolderServiceCode =
  | "SCHEMA_INVALID"
  | "NAME_TAKEN"
  | "NOT_FOUND"
  | "UNKNOWN_HOST"
  | "UNKNOWN_RULESET";

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
  const manifest = validateAgainstRepo(cfg, value);

  const file = join(cfg.foldersDir, `${manifest.name}.yaml`);
  if (existsSync(file)) {
    throw new FolderServiceError(`folder '${manifest.name}' already exists (folders/${manifest.name}.yaml)`, "NAME_TAKEN");
  }

  writeFileSync(file, canonicalEmit(manifest, FOLDER_KEY_ORDER), "utf8");
  return { manifest, relPath: `folders/${manifest.name}.yaml` };
}

/**
 * Replace an existing manifest wholesale. The name is taken from the URL, not
 * the body: allowing a rename here would silently orphan the compiled
 * artifacts and the live Syncthing folder ID, which is a different (and much
 * more dangerous) operation than an edit.
 */
export function updateFolder(cfg: ApiConfig, name: string, value: unknown): CreatedFolder {
  const file = join(cfg.foldersDir, `${name}.yaml`);
  if (!existsSync(file)) {
    throw new FolderServiceError(`folder not found: ${name}`, "NOT_FOUND");
  }
  const incoming = (value ?? {}) as Record<string, unknown>;
  if (typeof incoming.name === "string" && incoming.name !== name) {
    throw new FolderServiceError(
      `cannot rename '${name}' to '${incoming.name}' — delete and recreate instead`,
      "SCHEMA_INVALID",
    );
  }
  const manifest = validateAgainstRepo(cfg, { ...incoming, name });
  writeManifestPreserving(file, manifest);
  return { manifest, relPath: `folders/${name}.yaml` };
}

/** Remove the manifest. Live host folders and on-disk data are untouched. */
export function deleteFolder(cfg: ApiConfig, name: string): { relPath: string } {
  const file = join(cfg.foldersDir, `${name}.yaml`);
  if (!existsSync(file)) {
    throw new FolderServiceError(`folder not found: ${name}`, "NOT_FOUND");
  }
  unlinkSync(file);
  return { relPath: `folders/${name}.yaml` };
}

/** Park or un-park a folder without touching the rest of its manifest. */
export function setFolderEnabled(cfg: ApiConfig, name: string, enabled: boolean): CreatedFolder {
  const file = join(cfg.foldersDir, `${name}.yaml`);
  if (!existsSync(file)) {
    throw new FolderServiceError(`folder not found: ${name}`, "NOT_FOUND");
  }
  const raw = readFileSync(file, "utf8");
  const current = parseYaml(raw) as Record<string, unknown>;
  // Enabled is the default, so drop the key rather than writing `enabled: true`
  // and leaving noise in the committed YAML.
  if (enabled) delete current.enabled;
  else current.enabled = false;

  // Validate the outcome before touching the file, so a manifest that is
  // already broken fails here rather than being half-rewritten.
  const manifest = validateAgainstRepo(cfg, { ...current, name });

  // Then write ONLY the one key. This verb knows exactly what it changes, so it
  // has no business running the general update path — that one reconciles the
  // file against a schema-validated object and deletes anything missing from
  // it, which is far more authority than "park this folder" needs.
  const doc = parseDocument(raw);
  if (enabled) doc.delete("enabled");
  else doc.set("enabled", false);
  writeFileSync(file, doc.toString(), "utf8");

  return { manifest, relPath: `folders/${name}.yaml` };
}

/**
 * Write a manifest over an existing file without flattening it.
 *
 * These YAML files are hand-written and live in git; the comments are where the
 * reasoning is kept ("NAS lists second-precision modtimes, Drive millisecond —
 * without a tolerance bisync's final listing self-check aborts on every
 * photo"). Re-emitting the whole document from the parsed object is correct
 * about values and silently deletes all of that, so a one-character schedule
 * edit would cost the file its entire history of why.
 *
 * Instead: touch only the top-level keys whose value actually changed. Anything
 * the edit did not affect keeps its comments, its ordering and its formatting
 * byte-for-byte. A key that did change loses the comments nested inside it —
 * unavoidable, since that subtree is being replaced.
 */
function writeManifestPreserving(file: string, manifest: FolderManifest): void {
  if (!existsSync(file)) {
    writeFileSync(file, canonicalEmit(manifest, FOLDER_KEY_ORDER), "utf8");
    return;
  }
  const doc = parseDocument(readFileSync(file, "utf8"));
  if (!isMap(doc.contents)) {
    // Not a mapping (empty or corrupt); nothing to preserve.
    writeFileSync(file, canonicalEmit(manifest, FOLDER_KEY_ORDER), "utf8");
    return;
  }

  const next = manifest as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(next)) {
    const current = doc.hasIn([key]) ? (doc.getIn([key], false) as unknown) : undefined;
    const currentJs =
      current !== undefined && typeof current === "object" && current !== null && "toJSON" in current
        ? (current as { toJSON: () => unknown }).toJSON()
        : current;
    if (!doc.hasIn([key]) || !sameValue(currentJs, value)) doc.set(key, value);
  }
  for (const key of doc.contents.items.map((i) => String((i.key as { value?: unknown })?.value))) {
    if (!(key in next)) doc.delete(key);
  }

  writeFileSync(file, doc.toString(), "utf8");
}

/** Order-insensitive deep equality, so a re-serialised object isn't "changed". */
function sameValue(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => x !== undefined)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`).join(",")}}`;
}

/** Schema validation plus the cross-references only the config repo can answer. */
function validateAgainstRepo(cfg: ApiConfig, value: unknown) {
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

  const anchor = manifest.bisync?.anchor;
  if (anchor && !Object.keys(manifest.paths).includes(anchor)) {
    throw new FolderServiceError(
      `bisync.anchor '${anchor}' must be one of the folder's path hosts: ${Object.keys(manifest.paths).join(", ")}`,
      "UNKNOWN_HOST",
    );
  }
  return manifest;
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
  {
    const file = join(cfg.foldersDir, `${name}.yaml`);
    if (existsSync(file)) {
      const raw = parseYaml(readFileSync(file, "utf8")) as { enabled?: boolean } | null;
      if (raw?.enabled === false) {
        throw new FolderServiceError(
          `folder '${name}' is disabled — enable it before applying`,
          "SCHEMA_INVALID",
        );
      }
    }
  }
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
): Promise<Record<string, { folder: unknown; ignores: unknown; ignoresError: string | null }>> {
  const out: Record<string, { folder: unknown; ignores: unknown; ignoresError: string | null }> = {};
  for (const host of Object.keys(p.perHost)) {
    const c = pool.syncthing(host);
    let folder: unknown = null;
    let ignores: unknown = null;
    let ignoresError: string | null = null;
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
        // Same reasoning as the folder read above: a failure that isn't a clean
        // "absent" must NOT pass through as a benign value, or the DIVERGENT
        // gate below waves it through. Syncthing echoes the stored file back
        // even when it discarded every pattern, so the line comparison alone
        // cannot see a rejected ignore file.
        ignoresError = ig.error ?? null;
      } catch (err) {
        ignores = [];
        ignoresError = `could not read ignores: ${(err as Error).message ?? String(err)}`;
      }
      // Bridge: planner type requires label; adapter type doesn't.
      const f = folder as { id: string; label?: string };
      if (f.label === undefined) f.label = f.id;
    }
    out[host] = { folder, ignores, ignoresError };
  }
  return out;
}
