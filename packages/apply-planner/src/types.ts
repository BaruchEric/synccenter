import type { SyncthingClient } from "@synccenter/adapters/syncthing";
import type { RcloneClient } from "@synccenter/adapters/rclone";

export type HostName = string;

export type FolderType = "send-receive" | "send-only" | "receive-only" | "receive-encrypted";

export interface SyncthingFolderDevice {
  deviceID: string;
}

export interface SyncthingFolderConfig {
  id: string;
  label: string;
  path: string;
  type: "sendreceive" | "sendonly" | "receiveonly" | "receiveencrypted";
  devices: SyncthingFolderDevice[];
  ignorePerms?: boolean;
  fsWatcherEnabled?: boolean;
  fsWatcherDelayS?: number;
  paused?: boolean;
}

export type SyncthingOp =
  | { kind: "addDevice"; host: HostName; deviceID: string; name: string; addresses?: string[] }
  | { kind: "addFolder"; host: HostName; folder: SyncthingFolderConfig }
  | { kind: "patchFolder"; host: HostName; folderId: string; patch: Partial<SyncthingFolderConfig> }
  | { kind: "setIgnores"; host: HostName; folderId: string; lines: string[] }
  | { kind: "removeFolder"; host: HostName; folderId: string };

export interface SchedulePlan {
  anchor: HostName;
  folder: string;
  cron: string;
  command: string;
  filtersFile: string;
}

export interface ApplyPlan {
  folder: string;
  perHost: Record<HostName, SyncthingOp[]>;
  schedule: SchedulePlan[];
  warnings: string[];
}

export interface DriftReport {
  manifestOnly: SyncthingOp[];
  liveOnly: { host: HostName; folderId: string }[];
  divergent: { host: HostName; path: string; expected: unknown; actual: unknown }[];
}

export interface PlanContext {
  rulesetsDir: string;
  importsDir: string;
  compiledRulesDir: string;
  commitSha?: string;
  now?: Date;
}

export interface SecretsResolver {
  resolve(ref: string): string;
}

export interface ApplyOpts {
  dryRun?: boolean;
  prune?: boolean;
  force?: boolean;
  hostTimeoutMs?: number;
}

export interface HostApplyResult {
  host: HostName;
  status: "applied" | "skipped" | "failed";
  ops: SyncthingOp[];
  error?: { code: string; message: string };
}

export interface ApplyResult {
  folder: string;
  hosts: HostApplyResult[];
  schedule: SchedulePlan[];
  verified: boolean;
}

export interface AdapterPool {
  syncthing(host: HostName): SyncthingClient;
  rclone(host: HostName): RcloneClient;
}
