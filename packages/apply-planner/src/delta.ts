import type { ApplyPlan, DriftReport, HostName, SyncthingFolderConfig, SyncthingOp } from "./types.ts";

export interface LiveHostState {
  folder: SyncthingFolderConfig | null;
  ignores: string[] | null;
}

export type LiveState = Record<HostName, LiveHostState>;

export function computeDelta(p: ApplyPlan, live: LiveState): DriftReport {
  const manifestOnly: SyncthingOp[] = [];
  const liveOnly: { host: HostName; folderId: string }[] = [];
  const divergent: { host: HostName; path: string; expected: unknown; actual: unknown }[] = [];

  for (const host of Object.keys(p.perHost)) {
    const ops = p.perHost[host]!;
    const liveState = live[host];

    if (!liveState || !liveState.folder) {
      // Folder doesn't exist on the host at all — every op is manifest-only.
      manifestOnly.push(...ops);
      continue;
    }

    // Folder exists. Check if the id matches the plan.
    if (liveState.folder.id !== p.folder) {
      liveOnly.push({ host, folderId: liveState.folder.id });
      manifestOnly.push(...ops);
      continue;
    }

    // Folder exists with matching id; check addFolder field-by-field.
    const addFolderOp = ops.find((o) => o.kind === "addFolder");
    if (addFolderOp && addFolderOp.kind === "addFolder") {
      compareFolderFields(host, addFolderOp.folder, liveState.folder, divergent);
    }

    // Check ignores.
    const setIgnoresOp = ops.find((o) => o.kind === "setIgnores");
    if (setIgnoresOp && setIgnoresOp.kind === "setIgnores") {
      const expected = setIgnoresOp.lines;
      const actual = liveState.ignores ?? [];
      if (!arrayEq(stripMeta(expected), stripMeta(actual))) {
        divergent.push({
          host,
          path: `perHost.${host}.ignores`,
          expected,
          actual,
        });
      }
    }
  }

  return { manifestOnly, liveOnly, divergent };
}

function compareFolderFields(
  host: HostName,
  expected: SyncthingFolderConfig,
  actual: SyncthingFolderConfig,
  out: { host: HostName; path: string; expected: unknown; actual: unknown }[],
): void {
  const fields: (keyof SyncthingFolderConfig)[] = ["path", "type", "ignorePerms", "fsWatcherEnabled", "fsWatcherDelayS"];
  for (const f of fields) {
    const e = expected[f];
    const a = actual[f];
    if (e !== undefined && e !== a) {
      out.push({ host, path: `perHost.${host}.folder.${f}`, expected: e, actual: a });
    }
  }
}

function stripMeta(lines: string[]): string[] {
  return lines.filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
}

function arrayEq(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}
