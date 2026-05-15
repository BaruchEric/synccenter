import { mapPolicy } from "./conflict.ts";
import { buildSchedulePlan } from "./schedule.ts";
import { PlanError } from "./errors.ts";
import type { FolderManifest, HostManifest } from "./load.ts";
import type {
  ApplyPlan,
  HostName,
  SecretsResolver,
  SyncthingOp,
  SchedulePlan,
  SyncthingFolderConfig,
} from "./types.ts";

const FOLDER_TYPE_TO_WIRE: Record<FolderManifest["type"], SyncthingFolderConfig["type"]> = {
  "send-receive": "sendreceive",
  "send-only": "sendonly",
  "receive-only": "receiveonly",
  "receive-encrypted": "receiveencrypted",
};

export interface PlanArgs {
  folder: FolderManifest;
  hosts: Record<string, HostManifest>;
  compiledIgnoreLines: string[];
  filtersFile: string;
  secrets: SecretsResolver;
}

export function plan(args: PlanArgs): ApplyPlan {
  const { folder, hosts, compiledIgnoreLines, filtersFile, secrets } = args;

  // 1. Validate that every host referenced in paths exists.
  for (const hostName of Object.keys(folder.paths)) {
    if (!hosts[hostName]) {
      throw new PlanError(
        `UNKNOWN_HOST: folder ${folder.name} references unknown host: ${hostName}`,
        "UNKNOWN_HOST",
      );
    }
  }

  // 2. If folder has cloud, find the anchor.
  let anchor: HostManifest | null = null;
  if (folder.cloud) {
    if (folder.cloud.anchor) {
      const named = hosts[folder.cloud.anchor];
      if (!named) {
        throw new PlanError(
          `UNKNOWN_HOST: cloud.anchor references unknown host: ${folder.cloud.anchor}`,
          "UNKNOWN_HOST",
        );
      }
      anchor = named;
    } else {
      const cloudEdges = Object.values(hosts).filter((h) => h.role === "cloud-edge");
      if (cloudEdges.length === 0) {
        throw new PlanError(
          `NO_CLOUD_EDGE_FOR_BISYNC: folder ${folder.name} has cloud: but no host has role: cloud-edge`,
          "NO_CLOUD_EDGE_FOR_BISYNC",
        );
      }
      if (cloudEdges.length > 1) {
        throw new PlanError(
          `MULTIPLE_CLOUD_EDGE: multiple hosts with role: cloud-edge (${cloudEdges
            .map((h) => h.name)
            .join(", ")}); set cloud.anchor on the folder`,
          "MULTIPLE_CLOUD_EDGE",
        );
      }
      anchor = cloudEdges[0]!;
    }
  }

  // 3. Resolve device IDs for each participating host.
  const allDeviceIds: { host: HostName; deviceID: string }[] = [];
  for (const hostName of Object.keys(folder.paths)) {
    const host = hosts[hostName]!;
    const deviceID = secrets.resolve(host.syncthing.device_id_ref);
    allDeviceIds.push({ host: hostName, deviceID });
  }

  // 4. Build per-host op lists.
  const perHost: Record<HostName, SyncthingOp[]> = {};
  const policy = mapPolicy(folder.conflict?.policy);
  for (const hostName of Object.keys(folder.paths)) {
    const localPath = folder.paths[hostName]!;
    const ov = folder.overrides?.[hostName] ?? {};
    const type = ov.type ?? folder.type;
    const ignorePerms = ov.ignore_perms ?? folder.ignore_perms;
    const fsWatcherEnabled = ov.fs_watcher_enabled ?? folder.fs_watcher_enabled;
    const fsWatcherDelay = ov.fs_watcher_delay_s ?? folder.fs_watcher_delay_s;

    const ops: SyncthingOp[] = [];
    // Add every OTHER host as a known device.
    for (const peer of allDeviceIds) {
      if (peer.host === hostName) continue;
      ops.push({
        kind: "addDevice",
        host: hostName as HostName,
        deviceID: peer.deviceID,
        name: peer.host,
      });
    }
    // Add the folder.
    const folderConfig: SyncthingFolderConfig = {
      id: folder.name,
      label: folder.name,
      path: localPath,
      type: FOLDER_TYPE_TO_WIRE[type],
      devices: allDeviceIds.map((d) => ({ deviceID: d.deviceID })),
      ...(ignorePerms !== undefined && { ignorePerms }),
      ...(fsWatcherEnabled !== undefined && { fsWatcherEnabled }),
      ...(fsWatcherDelay !== undefined && { fsWatcherDelayS: fsWatcherDelay }),
    };
    ops.push({ kind: "addFolder", host: hostName as HostName, folder: folderConfig });
    // Set ignores.
    ops.push({
      kind: "setIgnores",
      host: hostName as HostName,
      folderId: folder.name,
      lines: compiledIgnoreLines,
    });
    perHost[hostName] = ops;
    // Quiet unused vars (reserved for future conflict/policy patching):
    void policy;
  }

  // 5. Build schedule.
  let schedule: SchedulePlan[] = [];
  if (anchor) {
    schedule = buildSchedulePlan(folder, anchor, filtersFile);
  }

  return {
    folder: folder.name,
    perHost,
    schedule,
    warnings: [],
  };
}
