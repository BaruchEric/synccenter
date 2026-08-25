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

/** `folder.versioning` as Syncthing stores it: empty type = off, string params. */
export interface SyncthingVersioning {
  type: "" | "trash" | "simple" | "staggered" | "external";
  params: Record<string, string>;
  cleanupIntervalS?: number;
  fsPath?: string;
  fsType?: string;
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
  rescanIntervalS?: number;
  ignorePerms?: boolean;
  versioning?: SyncthingVersioning;
}

export interface SyncthingFolderStatus {
  state: SyncthingFolderState;
  globalBytes: number;
  globalFiles: number;
  localBytes: number;
  localFiles: number;
  /**
   * Bytes that match the global index. `/folders/:name/state` passes this
   * response through verbatim and the dashboard's progress readout divides by
   * `globalBytes`, so it has to be declared here too — the web type used to be
   * the only place it appeared, which meant the server's own model of the wire
   * format said the field did not exist.
   */
  inSyncBytes: number;
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

/**
 * One row of /rest/system/connections. Only the fields the sync-window engine
 * reads: whether the device is reachable right now.
 */
export interface SyncthingConnection {
  connected: boolean;
  paused: boolean;
  address?: string;
}

export interface SyncthingConnections {
  connections: Record<string, SyncthingConnection>;
}

/**
 * /rest/db/completion for one device+folder pair — how much of OUR data that
 * device has, as a 0–100 percentage.
 */
export interface SyncthingCompletion {
  completion: number;
  globalBytes: number;
  needBytes: number;
  needItems: number;
  needDeletes: number;
  remoteState?: string;
}

/** One entry of /rest/system/log. `level` is absent on older daemons. */
export interface SyncthingLogEntry {
  when: string;
  message: string;
  level?: number;
}

export interface SyncthingLog {
  messages: SyncthingLogEntry[];
}

/** One failed item from /rest/folder/errors — a pull that keeps failing, and why. */
export interface SyncthingFolderError {
  path: string;
  error: string;
}

export interface SyncthingFolderErrors {
  folder: string;
  /** null, not [], when the folder has nothing failing — Syncthing's choice. */
  errors: SyncthingFolderError[] | null;
  page: number;
  perpage: number;
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
  rescanIntervalS?: number;
  ignorePerms?: boolean;
  versioning?: SyncthingVersioning;
}

/** Subset of fields needed to add a device. */
export interface NewSyncthingDevice {
  deviceID: string;
  name: string;
  addresses?: string[];
  paused?: boolean;
}
