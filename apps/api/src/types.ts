import type { SyncSettings, FolderManifest as PlannerFolder } from "@synccenter/apply-planner";

export interface FolderManifest {
  name: string;
  ruleset: string;
  type: string;
  /** Per-member paths: local absolute path for syncthing members, remote path for rclone members. */
  paths: Record<string, string>;
  bisync?: {
    anchor?: string;
    schedule?: string;
    flags?: string[];
  };
  /** Folder-level sync policy for Syncthing members (see folder.schema.json). */
  sync?: SyncSettings;
  conflict?: PlannerFolder["conflict"];
  overrides?: PlannerFolder["overrides"];
}
