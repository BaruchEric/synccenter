// Hand-rolled types covering the slice of the Syncthing REST API we use.
// Reference: https://docs.syncthing.net/dev/rest.html

export type SyncthingFolderType =
  | "sendreceive"
  | "sendonly"
  | "receiveonly"
  | "receiveencrypted";

export type SyncthingFolderState =
  | "idle"
  | "scanning"
  | "syncing"
  | "cleaning"
  | "error"
  | "unknown";

export interface SyncthingVersion {
  arch: string;
  longVersion: string;
  os: string;
  version: string;
}

export interface SyncthingStatus {
  myID: string;
  uptime: number;
  startTime: string;
  alloc: number;
  goroutines: number;
  cpuPercent?: number;
}

export interface SyncthingDeviceConfig {
  deviceID: string;
  name: string;
  addresses: string[];
  paused: boolean;
}

export interface SyncthingFolderConfig {
  id: string;
  label?: string;
  path: string;
  type: SyncthingFolderType;
  devices: { deviceID: string }[];
  paused: boolean;
  fsWatcherEnabled?: boolean;
  fsWatcherDelayS?: number;
  ignorePerms?: boolean;
}

export interface SyncthingFolderStatus {
  state: SyncthingFolderState;
  globalBytes: number;
  globalFiles: number;
  localBytes: number;
  localFiles: number;
  needBytes: number;
  needFiles: number;
  errors: number;
  pullErrors: number;
  sequence: number;
  stateChanged: string;
}

export interface SyncthingIgnores {
  ignore: string[];
  expanded: string[];
  /**
   * Syncthing's parse result for the ignore file as a WHOLE — null when it
   * loaded, a message when it did not.
   *
   * This is not a per-pattern warning. One unsupported glob makes Syncthing
   * discard EVERY rule in the file, and the folder then syncs with no ignores
   * at all. On 2026-08-05 a single multi-range bracket class did exactly that
   * on both arik members, so `/secrets/` — plaintext credentials the ruleset
   * exists to keep out of the cloud — was replicating, while folder state,
   * error counts and need counts all stayed green. Nothing in the codebase
   * noticed because this field was missing from the type.
   *
   * Always check it after setIgnores, and alert on it (see the
   * synccenter_folder_ignores_error metric).
   */
  error?: string | null;
}

export interface SyncthingEvent {
  id: number;
  globalID: number;
  time: string;
  type: string;
  data: unknown;
}

/** Subset of fields needed to add a folder. */
export interface NewSyncthingFolder {
  id: string;
  path: string;
  type: SyncthingFolderType;
  devices: { deviceID: string }[];
  label?: string;
  fsWatcherEnabled?: boolean;
  fsWatcherDelayS?: number;
  ignorePerms?: boolean;
}

/** Subset of fields needed to add a device. */
export interface NewSyncthingDevice {
  deviceID: string;
  name: string;
  addresses?: string[];
  paused?: boolean;
}
