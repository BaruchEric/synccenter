import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { SyncthingClient } from "@synccenter/adapters";
import type { ApiConfig } from "./config.ts";
import { listYamlNames } from "./lib/fs.ts";

export interface HostManifest {
  name: string;
  hostname?: string;
  ip?: string;
  os: "macos" | "linux" | "windows" | "qnap";
  role: "mesh-node" | "hub" | "cloud-edge";
  syncthing: {
    install_method: string;
    api_url: string;
    api_key_ref?: string;
    device_id_ref?: string;
  };
  rclone?: { rcd_url: string; auth_ref?: string };
}

export interface RegistryOpts {
  cfg: ApiConfig;
  env?: NodeJS.ProcessEnv;
  /** Test seam: pre-built clients keyed by host name. Bypasses env-based key lookup. */
  clients?: Map<string, SyncthingClient>;
}

export class HostRegistry {
  private readonly cfg: ApiConfig;
  private readonly env: NodeJS.ProcessEnv;
  private readonly injectedClients?: Map<string, SyncthingClient>;
  private readonly manifestCache = new Map<string, HostManifest>();
  private readonly clientCache = new Map<string, SyncthingClient>();

  constructor(opts: RegistryOpts) {
    this.cfg = opts.cfg;
    this.env = opts.env ?? process.env;
    this.injectedClients = opts.clients;
  }

  list(): string[] {
    return listYamlNames(this.cfg.hostsDir);
  }

  manifest(name: string): HostManifest | undefined {
    if (this.manifestCache.has(name)) return this.manifestCache.get(name);
    const path = join(this.cfg.hostsDir, `${name}.yaml`);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
    const parsed = parseYaml(raw) as HostManifest;
    this.manifestCache.set(name, parsed);
    return parsed;
  }

  /**
   * Get (or lazily build) a SyncthingClient for `name`.
   * Throws if the manifest is missing or no API key is available.
   */
  client(name: string): SyncthingClient {
    const m = this.manifest(name);
    if (!m) throw new HostRegistryError(`unknown host: ${name}`, "unknown-host");

    if (this.injectedClients) {
      const c = this.injectedClients.get(name);
      if (!c) throw new HostRegistryError(`no injected client for host: ${name}`, "no-client");
      return c;
    }
    const cached = this.clientCache.get(name);
    if (cached) return cached;

    if (!m.syncthing?.api_url) {
      throw new HostRegistryError(`host ${name} has no syncthing.api_url`, "no-url");
    }
    const apiKey = this.env[envKeyForHost(name)];
    if (!apiKey) {
      throw new HostRegistryError(
        `no API key for host ${name} (set ${envKeyForHost(name)})`,
        "no-key",
      );
    }
    const c = new SyncthingClient({ baseUrl: m.syncthing.api_url, apiKey });
    this.clientCache.set(name, c);
    return c;
  }
}

export function envKeyForHost(name: string): string {
  return `SC_HOST_API_KEY_${name.toUpperCase().replace(/-/g, "_")}`;
}

export class HostRegistryError extends Error {
  constructor(
    message: string,
    public readonly code: "unknown-host" | "no-url" | "no-key" | "no-client",
  ) {
    super(message);
    this.name = "HostRegistryError";
  }
}
