// rclone rcd response types — covering the slice we use.
// Reference: https://rclone.org/rc/

export interface RcloneVersion {
  version: string;
  goVersion: string;
  os: string;
  arch: string;
  decomposed?: number[];
}

export interface RclonePid {
  pid: number;
}

export interface RcloneStats {
  bytes: number;
  checks: number;
  deletes?: number;
  elapsedTime: number;
  errors: number;
  eta?: number | null;
  fatalError?: boolean;
  speed?: number;
  totalBytes?: number;
  totalChecks?: number;
  totalTransfers?: number;
  transferTime?: number;
  transfers?: number;
  lastError?: string;
  transferring?: RcloneTransferring[];
}

export interface RcloneTransferring {
  name: string;
  size: number;
  bytes: number;
  speed: number;
  speedAvg: number;
  eta?: number;
  group?: string;
}

export interface RcloneRemoteList {
  remotes: string[];
}

export interface RcloneAbout {
  total?: number;
  used?: number;
  free?: number;
  trashed?: number;
  other?: number;
}

export interface RcloneJobStatus {
  id: number;
  group?: string;
  startTime: string;
  endTime?: string;
  duration: number;
  finished: boolean;
  success: boolean;
  output?: unknown;
  error?: string;
}

export interface RcloneJobList {
  jobids: number[];
  executeId?: string;
}

export interface BisyncParams {
  /** First path — typically the local Syncthing folder root. */
  path1: string;
  /** Second path — typically a remote like `gdrive:sync/code`. */
  path2: string;
  /** Run asynchronously; the call returns immediately with `{ jobid }`. Default false. */
  async?: boolean;
  /** Continue past errors when feasible. */
  resilient?: boolean;
  /** Force a fresh resync (one-time bootstrap or recovery). */
  resync?: boolean;
  /** How to resolve conflicts: 'newer' | 'older' | 'larger' | 'smaller' | 'path1' | 'path2' | 'none'. */
  conflictResolve?: string;
  /** Comma-separated comparison attrs, e.g. "size,modtime,checksum". */
  compare?: string;
  /** Path to a filter file (rclone filter syntax). */
  filtersFile?: string;
  /** Max lock duration, e.g. "2m". */
  maxLock?: string;
  /** Dry run — show what would happen, don't change anything. */
  dryRun?: boolean;
  /** Pass-through for any flag not covered by the convenience fields above. */
  extra?: Record<string, unknown>;
}

export interface BisyncResult {
  /** Present when async=true. */
  jobid?: number;
  /** Output captured from the bisync run (sync mode). */
  [k: string]: unknown;
}
