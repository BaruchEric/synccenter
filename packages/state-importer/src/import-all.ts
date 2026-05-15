import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { parse } from "yaml";
import { SyncthingClient } from "@synccenter/adapters/syncthing";
import { importFolder } from "./import-folder.ts";
import { importHost, type HostShell } from "./import-host.ts";
import { ImportError } from "./errors.ts";
import type { ImportOpts, ImportResult } from "./types.ts";

export async function importAll(opts: ImportOpts): Promise<ImportResult[]> {
  const results: ImportResult[] = [];

  // 1. Discover every folder ID present on any host.
  const folderIds = new Set<string>();
  for (const host of opts.hosts) {
    const client = new SyncthingClient({ baseUrl: host.apiUrl, apiKey: host.apiKey, fetch: opts.fetch });
    try {
      const folders = await client.listFolders();
      for (const f of folders) folderIds.add(f.id);
    } catch (err) {
      throw new ImportError(`failed to list folders on ${host.name}`, "HOST_UNREACHABLE", err);
    }
  }

  // 2. Import each folder.
  for (const id of [...folderIds].sort()) {
    results.push(await importFolder(id, opts));
  }

  // 3. Import every declared host.
  for (const host of opts.hosts) {
    const onDisk = readHostShell(opts.configDir, host);
    results.push(await importHost(onDisk, opts));
  }

  return results;
}

function readHostShell(
  configDir: string,
  host: { name: string; apiUrl: string; apiKey: string },
): HostShell {
  const target = join(configDir, "hosts", `${host.name}.yaml`);
  if (!existsSync(target)) {
    return {
      name: host.name,
      hostname: host.name,
      os: "linux",
      apiUrl: host.apiUrl,
      apiKey: host.apiKey,
    };
  }
  const doc = parse(readFileSync(target, "utf8")) as Record<string, unknown>;
  const { name, hostname, os, ...rest } = doc;
  return {
    name: (name as string) ?? host.name,
    hostname: (hostname as string) ?? host.name,
    os: (os as HostShell["os"]) ?? "linux",
    apiUrl: host.apiUrl,
    apiKey: host.apiKey,
    preserve: rest,
  };
}
