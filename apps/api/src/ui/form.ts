import { parse as parseYaml } from "yaml";
import type { FolderManifest } from "@synccenter/apply-planner";

/** express.urlencoded({extended:false}) body: string | string[] per key. */
export type FormBody = Record<string, unknown>;

export interface ParsedJobForm {
  /** Best-effort manifest — rendered as YAML preview even when errors exist. */
  manifest: FolderManifest;
  /** Blocking problems, phrased as fixes. */
  errors: string[];
  /** Non-blocking observations (relative paths, odd cron, …). */
  warnings: string[];
}

export const NAME_RE = /^[a-z][a-z0-9-]*$/;
export const TYPES = ["send-receive", "send-only", "receive-only", "receive-encrypted"] as const;
const POLICIES = ["newer", "older", "keep-both", "require-resolve"] as const;
const VERSIONING = ["off", "trash", "simple", "staggered"] as const;

function one(body: FormBody, key: string): string {
  const v = body[key];
  if (Array.isArray(v)) return String(v[0] ?? "").trim();
  return v === undefined || v === null ? "" : String(v).trim();
}

function many(body: FormBody, key: string): string[] {
  const v = body[key];
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]).map((x) => String(x));
}

function isEnum<T extends readonly string[]>(list: T, v: string): v is T[number] {
  return (list as readonly string[]).includes(v);
}

/** A path Syncthing will accept on some OS: POSIX-absolute, ~-rooted, or a Windows drive. */
function looksAbsolute(p: string): boolean {
  return p.startsWith("/") || p.startsWith("~") || /^[A-Za-z]:[\\/]/.test(p);
}

/**
 * Build a FolderManifest from the job form. Never throws — collects errors so
 * the preview pane can render the partial YAML alongside what needs fixing.
 * `rcloneHosts` names the engine: rclone hosts — their path rows hold remote
 * paths, not local ones.
 */
export function parseJobForm(
  body: FormBody,
  rcloneHosts: ReadonlySet<string> = new Set(),
): ParsedJobForm {
  const errors: string[] = [];
  const warnings: string[] = [];

  const name = one(body, "name");
  if (!name) errors.push("Name is required.");
  else if (!NAME_RE.test(name)) {
    errors.push("Name must be lowercase letters, digits, and hyphens, starting with a letter (it becomes the Syncthing folder ID).");
  }

  const ruleset = one(body, "ruleset");
  if (!ruleset) errors.push("Pick a ruleset — it compiles to .stignore and filter.rclone.");

  const typeRaw = one(body, "type") || "send-receive";
  const type = isEnum(TYPES, typeRaw) ? typeRaw : "send-receive";
  if (!isEnum(TYPES, typeRaw)) errors.push(`Unknown folder type '${typeRaw}'.`);

  // paths: — parallel arrays host / path / htype (per-host type override).
  const hosts = many(body, "host");
  const paths = many(body, "path");
  const htypes = many(body, "htype");
  const pathMap: Record<string, string> = {};
  const seen = new Set<string>();
  const overrides: NonNullable<FolderManifest["overrides"]> = {};
  const rowCount = Math.max(hosts.length, paths.length);
  for (let i = 0; i < rowCount; i++) {
    const host = (hosts[i] ?? "").trim();
    const path = (paths[i] ?? "").trim();
    const htype = (htypes[i] ?? "").trim();
    if (!host && !path) continue; // untouched row
    if (!host) {
      errors.push(`Row ${i + 1}: pick a host for path '${path}'.`);
      continue;
    }
    if (!path) {
      errors.push(`Host '${host}': path is required.`);
      continue;
    }
    if (seen.has(host)) {
      errors.push(`Host '${host}' appears twice — one path per host.`);
      continue;
    }
    if (rcloneHosts.has(host)) {
      // The row is a remote path inside the member's rclone remote.
      seen.add(host);
      pathMap[host] = path;
      if (htype) errors.push(`'${host}' is an rclone member — it doesn't take a Syncthing type override.`);
      continue;
    }
    if (!looksAbsolute(path)) {
      warnings.push(`Path '${path}' on '${host}' is not absolute — Syncthing expects absolute paths.`);
    }
    seen.add(host);
    pathMap[host] = path;
    if (htype) {
      if (!isEnum(TYPES, htype)) errors.push(`Host '${host}': unknown type override '${htype}'.`);
      else if (htype !== type) overrides[host] = { type: htype };
    }
  }
  if (Object.keys(pathMap).length === 0) {
    errors.push("Add at least one host and path — a sync job needs somewhere to live.");
  }

  const manifest: FolderManifest = { name, ruleset, type, paths: pathMap };
  if (Object.keys(overrides).length > 0) manifest.overrides = overrides;

  // conflict:
  const policy = one(body, "conflict_policy");
  if (policy) {
    if (isEnum(POLICIES, policy)) manifest.conflict = { policy };
    else errors.push(`Unknown conflict policy '${policy}'.`);
  }

  // versioning:
  const vt = one(body, "versioning_type");
  const vparamsRaw = one(body, "versioning_params");
  if (vt) {
    if (!isEnum(VERSIONING, vt)) {
      errors.push(`Unknown versioning type '${vt}'.`);
    } else {
      manifest.versioning = { type: vt };
      if (vparamsRaw) {
        try {
          const parsed: unknown = parseYaml(vparamsRaw);
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            errors.push("Versioning params must be `key: value` lines (a YAML map).");
          } else {
            const params: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
              if (v === null || typeof v === "object") {
                errors.push(`Versioning param '${k}' must be a scalar (string, number, or boolean).`);
              } else if (typeof v === "number" && !Number.isInteger(v)) {
                errors.push(`Versioning param '${k}' must be a whole number (got ${v}).`);
              } else {
                params[k] = v;
              }
            }
            if (Object.keys(params).length > 0) manifest.versioning.params = params;
          }
        } catch {
          errors.push("Versioning params are not valid YAML — use `key: value` lines like `keep: 5`.");
        }
      }
    }
  } else if (vparamsRaw) {
    warnings.push("Versioning params are ignored until a versioning type is picked.");
  }

  // tuning
  if (one(body, "ignore_perms") === "on") manifest.ignore_perms = true;
  const watcher = one(body, "fs_watcher");
  if (watcher === "true") manifest.fs_watcher_enabled = true;
  else if (watcher === "false") manifest.fs_watcher_enabled = false;
  const delayRaw = one(body, "fs_watcher_delay_s");
  if (delayRaw) {
    const delay = Number(delayRaw);
    if (!Number.isInteger(delay) || delay < 1 || delay > 3600) {
      errors.push("Watcher delay must be a whole number of seconds between 1 and 3600.");
    } else {
      manifest.fs_watcher_delay_s = delay;
    }
  }

  // bisync: — schedule/flags/anchor for the rclone members listed under paths.
  const anchor = one(body, "bisync_anchor");
  const schedule = one(body, "bisync_schedule");
  const flagsRaw = one(body, "bisync_flags");
  const rcloneMembers = Object.keys(pathMap).filter((h) => rcloneHosts.has(h));
  if (anchor || schedule || flagsRaw) {
    if (rcloneMembers.length === 0) {
      warnings.push("Bisync settings only take effect once an rclone member (e.g. gdrive) is added under paths.");
    }
    if (anchor && rcloneHosts.has(anchor)) {
      errors.push(`Anchor '${anchor}' is an rclone member — the anchor must be a Syncthing host.`);
    }
    const bisync: NonNullable<FolderManifest["bisync"]> = {};
    if (anchor && !rcloneHosts.has(anchor)) bisync.anchor = anchor;
    if (schedule) {
      bisync.schedule = schedule;
      if (schedule.split(/\s+/).length !== 5) {
        warnings.push(`Bisync schedule '${schedule}' doesn't look like a 5-field cron expression.`);
      }
    }
    const flags = flagsRaw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (flags.length > 0) bisync.flags = flags;
    if (Object.keys(bisync).length > 0) manifest.bisync = bisync;
  } else if (rcloneMembers.length > 0) {
    warnings.push(`Members ${rcloneMembers.join(", ")} won't bisync until a schedule is set (see the bisync section).`);
  }

  return { manifest, errors, warnings };
}
