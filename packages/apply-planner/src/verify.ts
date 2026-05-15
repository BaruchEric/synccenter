import { computeDelta, type LiveState } from "./delta.ts";
import type { AdapterPool, ApplyPlan, DriftReport, HostName, SyncthingFolderConfig } from "./types.ts";

export interface VerifyResult {
  verified: boolean;
  report: DriftReport;
}

export async function verify(p: ApplyPlan, pool: AdapterPool): Promise<VerifyResult> {
  const live: LiveState = {};
  for (const host of Object.keys(p.perHost) as HostName[]) {
    const client = pool.syncthing(host);
    let folder: SyncthingFolderConfig | null = null;
    let ignores: string[] | null = null;
    try {
      const raw = await client.getFolder(p.folder);
      folder = raw ? normalizeFolder(raw) : null;
    } catch {
      folder = null;
    }
    if (folder) {
      try {
        const ig = await client.getIgnores(p.folder);
        ignores = ig.ignore ?? [];
      } catch {
        ignores = [];
      }
    }
    live[host] = { folder, ignores };
  }
  const report = computeDelta(p, live);
  const verified = report.divergent.length === 0 && report.liveOnly.length === 0;
  return { verified, report };
}

function normalizeFolder(raw: { id: string; label?: string; path: string; type: SyncthingFolderConfig["type"]; devices: { deviceID: string }[]; paused?: boolean; fsWatcherEnabled?: boolean; fsWatcherDelayS?: number; ignorePerms?: boolean }): SyncthingFolderConfig {
  return {
    id: raw.id,
    label: raw.label ?? raw.id,
    path: raw.path,
    type: raw.type,
    devices: raw.devices,
    paused: raw.paused,
    fsWatcherEnabled: raw.fsWatcherEnabled,
    fsWatcherDelayS: raw.fsWatcherDelayS,
    ignorePerms: raw.ignorePerms,
  };
}
