import { getToken, clearToken } from "@/lib/auth";

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "/api";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: string | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }
  if (res.status === 401) {
    clearToken();
    location.reload();
    throw new ApiError("unauthorized", 401);
  }
  if (!res.ok) {
    const msg =
      parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string"
        ? parsed.error
        : `${method} ${path} → ${res.status} ${res.statusText}`;
    throw new ApiError(msg, res.status);
  }
  return parsed as T;
}

export const api = {
  get: <T>(path: string) => send<T>("GET", path),
  post: <T>(path: string, body?: unknown) => send<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => send<T>("PUT", path, body),
  del: <T>(path: string, body?: unknown) => send<T>("DELETE", path, body),
};

// Typed shapes (a subset; expand as needed).
export interface Health { ok: boolean; version: string }
export interface FoldersList { folders: string[] }
export interface RulesList { rules: string[] }
export interface HostsList { hosts: string[] }
export interface ApplyHistory {
  history: Array<{
    id: number;
    ts: string;
    actor: string;
    source: "api" | "cli" | "ui" | "mcp";
    target_kind: string;
    target_name: string;
    result: "ok" | "error" | "dry-run";
    note: string | null;
  }>;
}
export interface ScheduleList {
  jobs: Array<{
    folder: string;
    anchor: string;
    member: string;
    cron: string;
    command: string;
    filtersFile: string;
  }>;
  /** Cron-opened Syncthing sync windows for scheduled members. */
  windows?: Array<{
    folder: string;
    host: string;
    cron: string;
    maxWindowMinutes: number;
  }>;
}
/** What a bisync is doing right now, as served by /runs and pushed over /events. */
export type RunPhase = "starting" | "checking" | "transferring" | "finished";
export interface RunView {
  id: number;
  folder: string;
  member: string | null;
  jobid: number | null;
  started_at: string;
  finished_at: string | null;
  state: "running" | "done" | "failed" | "stopped";
  phase: RunPhase;
  /** 0–1, or null while bisync is still listing and has no denominator. */
  fraction: number | null;
  bytes: number;
  total_bytes: number;
  transfers: number;
  checks: number;
  listed: number;
  errors: number;
  speed: number;
  eta: number | null;
  current: string | null;
  error: string | null;
  actor: string;
  source: string;
  dry_run: number;
  resync: number;
}
export interface RunsList {
  runs: RunView[];
  activeCount: number;
}
/** How a Syncthing member participates in a folder. */
export type SyncMode = "realtime" | "scheduled" | "manual";
/** One sync window — a held member resumed, catching up, and re-paused. */
export type WindowPhase = "starting" | "scanning" | "syncing" | "settling" | "finished";
export interface WindowView {
  id: number;
  folder: string;
  host: string;
  via: "schedule" | "manual";
  started_at: string;
  finished_at: string | null;
  state: "running" | "done" | "failed" | "timeout" | "stopped";
  max_minutes: number;
  sync_state: string | null;
  global_bytes: number;
  in_sync_bytes: number;
  need_bytes: number;
  need_files: number;
  errors: number;
  peers_total: number;
  peers_done: number;
  error: string | null;
  actor: string;
  source: string;
  phase: WindowPhase;
  /** 0–1 of the tree in sync locally, or null while scanning. */
  fraction: number | null;
}
export interface WindowsList {
  windows: WindowView[];
  activeCount: number;
}
/** A folder manifest as stored in synccenter-config/folders/<name>.yaml. */
export interface FolderManifest {
  name: string;
  ruleset: string;
  /** Absent means enabled; false parks the folder. */
  enabled?: boolean;
  type: string;
  paths: Record<string, string>;
  bisync?: { schedule?: string; anchor?: string; flags?: string[] };
  sync?: { mode?: SyncMode; schedule?: string; max_window_minutes?: number };
  overrides?: Record<string, { sync?: { mode?: SyncMode; schedule?: string } } | undefined>;
  [key: string]: unknown;
}

/**
 * Members that sync in windows rather than continuously — the ones "Sync now"
 * applies to. Mirrors the server's effectiveSync (override wins over folder).
 */
export function heldMembers(m: FolderManifest): string[] {
  return Object.keys(m.paths).filter((host) => {
    const mode = m.overrides?.[host]?.sync?.mode ?? m.sync?.mode ?? "realtime";
    return mode !== "realtime";
  });
}
/** A host manifest as stored in synccenter-config/hosts/<name>.yaml. */
export interface HostManifest {
  name: string;
  engine?: "syncthing" | "rclone";
  remote?: string;
  os?: string;
  role?: string;
  /**
   * Syncthing serves its GUI and its REST API off one listener, so `api_url`
   * is also the address of the web UI. Written from the API's vantage point,
   * not the browser's: `qnap-ts453d` carries a LAN address, `mac-studio` a
   * loopback one that only reaches that host's daemon from that host.
   */
  syncthing?: { api_url?: string };
}
export interface ConflictsList { conflicts: Array<{ id: number; folder: string; path: string; detected_at: string }> }
export interface FolderState {
  folder: string;
  perHost: Array<{
    host: string;
    /** How this member syncs: paused-between-windows members report scheduled/manual. */
    mode?: SyncMode;
    ok: boolean;
    error?: string;
    /** Passed through verbatim from Syncthing's `db/status`; this is the subset we read. */
    status?: {
      state: string;
      globalBytes: number;
      localBytes: number;
      inSyncBytes: number;
      needBytes: number;
      needFiles: number;
      errors: number;
      /** When the folder entered `state`. Absent on older Syncthing builds. */
      stateChanged?: string;
    };
  }>;
}
export interface ApplyResult {
  folder: string;
  dryRun?: boolean;
  stignorePreview?: string;
  rclonePreview?: string;
  warnings?: string[];
  payloadHash?: string;
  perHost?: Array<{ host: string; ok: boolean; error?: string }>;
}
