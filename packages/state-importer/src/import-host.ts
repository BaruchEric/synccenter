import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { SyncthingClient } from "@synccenter/adapters/syncthing";
import { canonicalEmit, HOST_KEY_ORDER } from "./canonical.ts";
import { unifiedDiff } from "./diff.ts";
import { ImportError } from "./errors.ts";
import type { ImportOpts, ImportResult } from "./types.ts";

export interface HostShell {
  name: string;
  hostname: string;
  os: "macos" | "linux" | "windows" | "qnap";
  apiUrl: string;
  apiKey: string;
  /** Existing manifest values we preserve (the importer cannot infer install_method, ssh, etc). */
  preserve?: Record<string, unknown>;
}

export async function importHost(host: HostShell, opts: ImportOpts): Promise<ImportResult> {
  const client = new SyncthingClient({ baseUrl: host.apiUrl, apiKey: host.apiKey, fetch: opts.fetch });

  let status: { myID: string };
  try {
    status = await client.getStatus();
  } catch (err) {
    throw new ImportError(`failed to query ${host.name}: ${(err as Error).message}`, "HOST_UNREACHABLE", err);
  }

  const target = join(opts.configDir, "hosts", `${host.name}.yaml`);
  const existing = existsSync(target)
    ? readFileSync(target, "utf8")
    : "";

  // Preserve any operator-set fields not derivable from /rest/system/status.
  // The shape below is the minimum the importer can know on its own;
  // the secrets refs and install_method survive untouched if present on disk.
  const proposed: Record<string, unknown> = {
    name: host.name,
    hostname: host.hostname,
    os: host.os,
    ...host.preserve,
    syncthing: {
      ...((host.preserve?.syncthing as Record<string, unknown>) ?? {}),
      api_url: host.apiUrl,
      api_key_ref: ((host.preserve?.syncthing as { api_key_ref?: string })?.api_key_ref) ?? `secrets/syncthing-api-keys.enc.yaml#${host.name}`,
      device_id_ref: ((host.preserve?.syncthing as { device_id_ref?: string })?.device_id_ref) ?? `secrets/syncthing-device-ids.enc.yaml#${host.name}`,
      // Recorded but not committed if the operator's YAML omits it.
      _live_device_id: status.myID,
    },
  };
  // The _live_device_id is only included to help the operator see drift in the diff;
  // strip before emit if the operator wants pure manifest format.
  if (!proposed.syncthing || typeof proposed.syncthing !== "object") {
    throw new ImportError("internal: bad syncthing block", "WRITE_BLOCKED");
  }
  delete (proposed.syncthing as Record<string, unknown>)._live_device_id;

  const yaml = canonicalEmit(proposed, HOST_KEY_ORDER);
  if (existing === yaml) {
    return { resource: { kind: "host", name: host.name }, path: target, status: "identical" };
  }
  const diff = unifiedDiff(existing, yaml, target);
  if (!opts.write) {
    return { resource: { kind: "host", name: host.name }, path: target, status: "would-change", diff };
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, yaml, "utf8");
  return { resource: { kind: "host", name: host.name }, path: target, status: "written", diff };
}
