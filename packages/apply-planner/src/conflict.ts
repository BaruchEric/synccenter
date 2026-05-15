export type ConflictPolicy = "newer" | "older" | "keep-both" | "require-resolve";

export interface PolicyMapping {
  rcloneFlags: string[];
  syncthingMaxConflicts: number; // -1 = unlimited, 0 = disallow, N = cap
}

const DEFAULT_POLICY: ConflictPolicy = "newer";

export function mapPolicy(policy: ConflictPolicy | undefined): PolicyMapping {
  const p = policy ?? DEFAULT_POLICY;
  switch (p) {
    case "newer":
      return {
        rcloneFlags: ["--conflict-resolve=newer", "--conflict-loser=pathrename"],
        syncthingMaxConflicts: -1,
      };
    case "older":
      return {
        rcloneFlags: ["--conflict-resolve=older", "--conflict-loser=pathrename"],
        syncthingMaxConflicts: -1,
      };
    case "keep-both":
      return {
        rcloneFlags: ["--conflict-resolve=none", "--conflict-loser=num"],
        syncthingMaxConflicts: -1,
      };
    case "require-resolve":
      return {
        rcloneFlags: ["--conflict-resolve=none", "--conflict-loser=num"],
        syncthingMaxConflicts: 0,
      };
  }
}
