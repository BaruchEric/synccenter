import { join } from "node:path";
import {
  buildSchedulePlan,
  loadFolderManifest,
  loadAllHosts,
  createSecretsResolver,
  plan as buildPlan,
  isRcloneHost,
  isSyncthingHost,
  resolveBisyncAnchor,
  type ApplyPlan,
  type AdapterPool,
  type FolderManifest,
  type HostManifest,
  type SchedulePlan,
} from "@synccenter/apply-planner";
import { compile } from "@synccenter/rule-compiler";
import { SyncthingClient } from "@synccenter/adapters/syncthing";
import { RcloneClient as RcloneAdapterClient } from "@synccenter/adapters/rclone";
import type { HostInfo } from "@synccenter/state-importer";
import type { ApiConfig } from "../config.ts";
import { listYamlNames } from "./fs.ts";

type SecretsResolver = ReturnType<typeof createSecretsResolver>;

export interface ScheduleJobs {
  jobs: SchedulePlan[];
  /** One message per folder whose legs could not be planned; [] when all did. */
  errors: string[];
}

/**
 * Every scheduled bisync leg across the config repo, planned WITHOUT the
 * secrets resolver.
 *
 * The full plan needs device IDs, which means sops, which the deployed API
 * container does not have — so for months `GET /schedule` answered with no
 * jobs at all and the dashboard read every folder as "local mesh only". The
 * schedule itself never needed a secret: anchor, remote, cron and flags are
 * all in the manifests. A folder that cannot be planned is reported by name
 * and does not blank the others.
 */
export function planScheduleJobs(cfg: ApiConfig): ScheduleJobs {
  const jobs: SchedulePlan[] = [];
  const errors: string[] = [];
  let hosts: Record<string, HostManifest>;
  try {
    hosts = loadAllHosts(cfg.hostsDir);
  } catch (err) {
    return { jobs, errors: [(err as Error).message] };
  }
  for (const name of listYamlNames(cfg.foldersDir)) {
    if (name.startsWith("example-")) continue;
    let folder: FolderManifest;
    try {
      folder = loadFolderManifest(join(cfg.foldersDir, `${name}.yaml`));
    } catch (err) {
      errors.push(`${name}: ${(err as Error).message}`);
      continue;
    }
    // A disabled folder keeps its manifest but contributes no cron lines.
    if (folder.enabled === false) continue;
    const members = Object.keys(folder.paths)
      .map((h) => hosts[h])
      .filter((h): h is HostManifest => h !== undefined)
      .filter(isRcloneHost);
    if (members.length === 0) continue;
    try {
      const anchor = resolveBisyncAnchor(folder, hosts);
      for (const member of members) {
        jobs.push(...buildSchedulePlan(folder, member, anchor, rcloneFilterPath(cfg, folder)));
      }
    } catch (err) {
      errors.push(`${name}: ${(err as Error).message}`);
    }
  }
  return { jobs, errors };
}

export function buildFolderPlanFor(
  cfg: ApiConfig,
  folder: FolderManifest,
  hosts: Record<string, HostManifest> = loadAllHosts(cfg.hostsDir),
  secrets: SecretsResolver = createSecretsResolver({ configDir: cfg.configDir }),
): ApplyPlan {
  const compiled = compile(join(cfg.rulesDir, `${folder.ruleset}.yaml`), {
    rulesetsDir: cfg.rulesDir,
    importsDir: cfg.importsDir,
  });
  const compiledIgnoreLines = compiled.stignore
    .split("\n")
    .filter((l) => l && !l.startsWith("#"));
  return buildPlan({
    folder,
    hosts,
    compiledIgnoreLines,
    filtersFile: rcloneFilterPath(cfg, folder),
    secrets,
  });
}

/**
 * Where the compiled rclone filter for a folder lives.
 *
 * Compilation is per-ruleset, not per-folder — two folders sharing a ruleset
 * share one artifact — so the path is keyed by `ruleset`. Anything that needs
 * the file must go through here: computing it from the folder name instead
 * silently misses every time, and the only symptom is a 409 saying the filter
 * has not been compiled yet.
 */
export function rcloneFilterPath(cfg: ApiConfig, folder: { ruleset: string }): string {
  return join(cfg.compiledDir, folder.ruleset, "filter.rclone");
}

/**
 * The filter path to hand to the rclone daemon.
 *
 * When SC_RCLONE_FILTERS_DIR is set the daemon lives elsewhere in the
 * filesystem, so we name the file the way IT sees it, using the same
 * `<ruleset>.rclone` convention the generated crontab uses — on-demand and
 * scheduled runs then load byte-for-byte the same filter.
 */
export function rcloneFilterPathForDaemon(
  cfg: ApiConfig,
  folder: { ruleset: string },
): { path: string; local: boolean } {
  if (cfg.rcloneFiltersDir) {
    return { path: `${cfg.rcloneFiltersDir.replace(/\/+$/, "")}/${folder.ruleset}.rclone`, local: false };
  }
  return { path: rcloneFilterPath(cfg, folder), local: true };
}

export function buildFolderPlan(cfg: ApiConfig, name: string): ApplyPlan {
  const folder = loadFolderManifest(join(cfg.foldersDir, `${name}.yaml`));
  return buildFolderPlanFor(cfg, folder);
}

export function buildAdapterPool(cfg: ApiConfig): AdapterPool {
  const hosts = loadAllHosts(cfg.hostsDir);
  const secrets = createSecretsResolver({ configDir: cfg.configDir });
  return {
    syncthing: (h: string) => {
      const host = hosts[h];
      if (!host) throw new Error(`unknown host: ${h}`);
      if (isRcloneHost(host)) throw new Error(`host ${h} is an rclone member, not a syncthing device`);
      return new SyncthingClient({
        baseUrl: host.syncthing.api_url,
        apiKey: secrets.resolve(host.syncthing.api_key_ref),
      });
    },
    rclone: (h: string) => {
      const host = hosts[h];
      if (!host) throw new Error(`unknown host: ${h}`);
      if (isRcloneHost(host)) throw new Error(`host ${h} is an rclone member; bisync runs on the anchor host`);
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

export function buildHostInfo(
  cfg: ApiConfig,
  hosts: Record<string, HostManifest> = loadAllHosts(cfg.hostsDir),
  secrets: SecretsResolver = createSecretsResolver({ configDir: cfg.configDir }),
): HostInfo[] {
  return Object.values(hosts)
    .filter(isSyncthingHost)
    .map((h) => ({
      name: h.name,
      apiUrl: h.syncthing.api_url,
      apiKey: secrets.resolve(h.syncthing.api_key_ref),
    }));
}
