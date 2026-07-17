import { join } from "node:path";
import {
  loadFolderManifest,
  loadAllHosts,
  createSecretsResolver,
  plan as buildPlan,
  isRcloneHost,
  isSyncthingHost,
  type ApplyPlan,
  type AdapterPool,
  type FolderManifest,
  type HostManifest,
} from "@synccenter/apply-planner";
import { compile } from "@synccenter/rule-compiler";
import { SyncthingClient } from "@synccenter/adapters/syncthing";
import { RcloneClient as RcloneAdapterClient } from "@synccenter/adapters/rclone";
import type { HostInfo } from "@synccenter/state-importer";
import type { ApiConfig } from "../config.ts";

type SecretsResolver = ReturnType<typeof createSecretsResolver>;

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
  const filtersFile = join(cfg.compiledDir, folder.ruleset, "filter.rclone");
  return buildPlan({ folder, hosts, compiledIgnoreLines, filtersFile, secrets });
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
