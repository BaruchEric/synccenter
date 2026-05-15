import { mapPolicy } from "./conflict.ts";
import type { FolderManifest, HostManifest } from "./load.ts";
import type { SchedulePlan, HostName } from "./types.ts";

export function buildSchedulePlan(
  folder: FolderManifest,
  anchor: HostManifest,
  filtersFile: string,
): SchedulePlan[] {
  if (!folder.cloud) return [];
  const schedule = folder.cloud.bisync?.schedule;
  if (!schedule) return [];

  const localPath = folder.paths[anchor.name];
  if (!localPath) return [];

  const remotePath = `${folder.cloud.rclone_remote}:${folder.cloud.remote_path}`;
  const conflictFlags = mapPolicy(folder.conflict?.policy).rcloneFlags;
  const userFlags = folder.cloud.bisync?.flags ?? [];

  // Strip any user-supplied --conflict-* flags so the unified policy wins,
  // unless the user explicitly opted out via conflict.policy missing AND raw flags present.
  const userConflict = userFlags.some((f) => f.startsWith("--conflict-"));
  const useUnified = folder.conflict?.policy !== undefined || !userConflict;
  const effectiveFlags = useUnified
    ? [...userFlags.filter((f) => !f.startsWith("--conflict-")), ...conflictFlags]
    : userFlags;

  const cmd = [
    "docker", "exec", "rclone-rcd",
    "rclone", "bisync",
    localPath,
    remotePath,
    `--filters-file=${filtersFile}`,
    ...effectiveFlags,
  ].join(" ");

  return [{
    anchor: anchor.name as HostName,
    folder: folder.name,
    cron: schedule,
    command: cmd,
    filtersFile,
  }];
}
