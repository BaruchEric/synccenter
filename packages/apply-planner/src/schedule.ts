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
  const conflictFlags = mapPolicy(folder.conflict?.policy).rcloneFlags;
  const userFlags = memberOverride.flags ?? folder.bisync?.flags ?? [];

  // Strip any user-supplied --conflict-* flags so the unified policy wins,
  // unless the user explicitly opted out via conflict.policy missing AND raw flags present.
  const userConflict = userFlags.some((f) => f.startsWith("--conflict-"));
  const useUnified = folder.conflict?.policy !== undefined || !userConflict;
  const effectiveFlags = useUnified
    ? [...userFlags.filter((f) => !f.startsWith("--conflict-")), ...conflictFlags]
    : userFlags;

  const cmd = [
    "docker", "exec", "rclone-rcd",
    // The rcd daemon gets --config on its own command line; a plain `docker
    // exec rclone` does not inherit it, so spell it out here too.
    "rclone", "--config=/config/rclone.conf", "bisync",
    localPath,
    remotePath,
    `--filters-file=${filtersFile}`,
    ...effectiveFlags,
  ].join(" ");

  return [{
    anchor: anchor.name as HostName,
    member: member.name as HostName,
    folder: folder.name,
    cron: schedule,
    command: cmd,
    filtersFile,
  }];
}
