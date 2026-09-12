import { dirname, join } from "node:path/posix";

import { mapPolicy } from "./conflict.ts";
import type { FolderManifest, RcloneHostManifest, SyncthingHostManifest } from "./load.ts";
import type { SchedulePlan, HostName } from "./types.ts";

/**
 * Build the scheduled bisync leg between one rclone member and the anchor.
 * Returns [] when the member has no effective schedule (bisync is opt-in).
 */
export function buildSchedulePlan(
  folder: FolderManifest,
  member: RcloneHostManifest,
  anchor: SyncthingHostManifest,
  filtersFile: string,
): SchedulePlan[] {
  const memberOverride = folder.overrides?.[member.name]?.bisync ?? {};
  const schedule = memberOverride.schedule ?? folder.bisync?.schedule;
  if (!schedule) return [];

  const localPath = folder.paths[anchor.name];
  if (!localPath) return [];
  const memberPath = folder.paths[member.name];
  if (!memberPath) return [];

  const remotePath = `${member.remote}:${memberPath}`;
  const effectiveFlags = effectiveBisyncFlags(folder, member.name);

  const cmd = [
    "docker", "exec", "rclone-rcd",
    "rclone", "--config=/config/rclone.conf", "bisync",
    localPath,
    remotePath,
    `--filters-file=${filtersFile}`,
    ...workdirFlag(filtersFile, effectiveFlags),
    ...effectiveFlags,
  ].join(" ");

  return [{ anchor: anchor.name as HostName, member: member.name as HostName,
    folder: folder.name, cron: schedule, command: cmd, filtersFile }];
}

/** Resolve the same policy for scheduled CLI and manual RC execution. */
export function effectiveBisyncFlags(folder: Pick<FolderManifest, "bisync" | "conflict" | "overrides">, member: string): string[] {
  const conflictFlags = mapPolicy(folder.conflict?.policy).rcloneFlags;
  const userFlags = folder.overrides?.[member]?.bisync?.flags ?? folder.bisync?.flags ?? [];

  // Strip any user-supplied --conflict-* flags so the unified policy wins,
  // unless the user explicitly opted out via conflict.policy missing AND raw flags present.
  const userConflict = userFlags.some((f) => f.startsWith("--conflict-"));
  const useUnified = folder.conflict?.policy !== undefined || !userConflict;
  return useUnified
    ? [...userFlags.filter((f) => !f.startsWith("--conflict-")), ...conflictFlags]
    : userFlags;

}

/**
 * rclone keeps every bisync baseline listing in --workdir, which defaults to
 * /root/.cache/rclone/bisync — inside the rclone-rcd container's writable
 * layer. Recreating that container therefore destroys the baselines, and the
 * next scheduled run aborts with "cannot find prior Path1 or Path2 listings",
 * recoverable only by a full --resync. That is exactly what happened on
 * 2026-09-05: one container recreation silently killed the cloud leg of every
 * folder, and nothing noticed for four days.
 *
 * The filters directory is already bind-mounted and survives, so park the
 * workdir beside it. A user-supplied --workdir still wins.
 */
export function bisyncWorkdirFor(filtersFile: string): string | undefined {
  const filtersDir = dirname(filtersFile);
  if (filtersDir === "." || filtersDir === "/") return undefined;
  return join(dirname(filtersDir), "bisync-workdir");
}

function workdirFlag(filtersFile: string, userFlags: readonly string[]): string[] {
  if (userFlags.some((f) => f === "--workdir" || f.startsWith("--workdir="))) return [];
  const workdir = bisyncWorkdirFor(filtersFile);
  return workdir ? [`--workdir=${workdir}`] : [];
}
