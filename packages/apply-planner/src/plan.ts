import { mapPolicy } from "./conflict.ts";
import { buildSchedulePlan } from "./schedule.ts";
import { PlanError } from "./errors.ts";
import { isRcloneHost, type FolderManifest, type HostManifest, type RcloneHostManifest, type SyncthingHostManifest } from "./load.ts";
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

/**
 * Resolve the syncthing host that runs a folder's bisync legs: `bisync.anchor`
 * when set, otherwise the unique host with role: cloud-edge. Throws PlanError
 * (UNKNOWN_HOST, ANCHOR_NOT_SYNCTHING, NO_CLOUD_EDGE_FOR_BISYNC,
 * MULTIPLE_CLOUD_EDGE, ANCHOR_NOT_IN_PATHS) when no valid anchor exists.
 */
export function resolveBisyncAnchor(
  folder: Pick<FolderManifest, "name" | "paths" | "bisync">,
  hosts: Record<string, HostManifest>,
): SyncthingHostManifest {
  let anchor: SyncthingHostManifest;
  if (folder.bisync?.anchor) {
    const named = hosts[folder.bisync.anchor];
    if (!named) {
      throw new PlanError(
        `UNKNOWN_HOST: bisync.anchor references unknown host: ${folder.bisync.anchor}`,
        "UNKNOWN_HOST",
      );
    }
    if (isRcloneHost(named)) {
      throw new PlanError(
        `ANCHOR_NOT_SYNCTHING: bisync.anchor ${named.name} is an rclone member; the anchor must be a syncthing host`,
        "ANCHOR_NOT_SYNCTHING",
      );
    }
    anchor = named;
  } else {
    const cloudEdges = Object.values(hosts).filter(
      (h): h is SyncthingHostManifest => !isRcloneHost(h) && h.role === "cloud-edge",
    );
    if (cloudEdges.length === 0) {
      throw new PlanError(
        `NO_CLOUD_EDGE_FOR_BISYNC: folder ${folder.name} has rclone members but no host has role: cloud-edge`,
        "NO_CLOUD_EDGE_FOR_BISYNC",
      );
    }
    if (cloudEdges.length > 1) {
      throw new PlanError(
        `MULTIPLE_CLOUD_EDGE: multiple hosts with role: cloud-edge (${cloudEdges
          .map((h) => h.name)
          .join(", ")}); set bisync.anchor on the folder`,
        "MULTIPLE_CLOUD_EDGE",
      );
    }
    anchor = cloudEdges[0]!;
  }
  if (!folder.paths[anchor.name]) {
    throw new PlanError(
      `ANCHOR_NOT_IN_PATHS: bisync anchor ${anchor.name} has no path entry in folder ${folder.name}`,
      "ANCHOR_NOT_IN_PATHS",
    );
  }
  return anchor;
}

export function plan(args: PlanArgs): ApplyPlan {
  const { folder, hosts, compiledIgnoreLines, filtersFile, secrets } = args;

  // 1. Validate that every member referenced in paths exists; partition by engine.
  const syncthingMembers: SyncthingHostManifest[] = [];
  const rcloneMembers: RcloneHostManifest[] = [];
  for (const hostName of Object.keys(folder.paths)) {
    const host = hosts[hostName];
    if (!host) {
      throw new PlanError(
        `UNKNOWN_HOST: folder ${folder.name} references unknown host: ${hostName}`,
        "UNKNOWN_HOST",
      );
    }
    if (isRcloneHost(host)) rcloneMembers.push(host);
    else syncthingMembers.push(host);
  }
  if (syncthingMembers.length === 0) {
    throw new PlanError(
      `NO_SYNCTHING_MEMBER: folder ${folder.name} has only rclone members; at least one syncthing member is required`,
      "NO_SYNCTHING_MEMBER",
    );
  }

  // 2. If any rclone member participates, resolve the bisync anchor.
  const anchor = rcloneMembers.length > 0 ? resolveBisyncAnchor(folder, hosts) : null;

  // 3. Resolve device IDs for each syncthing member.
  const allDeviceIds: { host: HostName; deviceID: string }[] = [];
  for (const host of syncthingMembers) {
    const deviceID = secrets.resolve(host.syncthing.device_id_ref);
    allDeviceIds.push({ host: host.name, deviceID });
  }

  // 4. Build per-host op lists (syncthing members only — rclone members have no daemon to configure).
  const perHost: Record<HostName, SyncthingOp[]> = {};
  const policy = mapPolicy(folder.conflict?.policy);
  for (const host of syncthingMembers) {
    const hostName = host.name;
    const localPath = folder.paths[hostName]!;
    const ov = folder.overrides?.[hostName] ?? {};
    const type = ov.type ?? folder.type;
    const ignorePerms = ov.ignore_perms ?? folder.ignore_perms;
    const fsWatcherEnabled = ov.fs_watcher_enabled ?? folder.fs_watcher_enabled;
    const fsWatcherDelay = ov.fs_watcher_delay_s ?? folder.fs_watcher_delay_s;

    const ops: SyncthingOp[] = [];
    // Add every OTHER syncthing member as a known device.
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

  // 5. Build the schedule: one bisync leg per rclone member, all running on the anchor.
  const schedule: SchedulePlan[] = [];
  for (const member of rcloneMembers) {
    schedule.push(...buildSchedulePlan(folder, member, anchor!, filtersFile));
  }

  return {
    folder: folder.name,
    perHost,
    schedule,
    warnings: [],
  };
}
