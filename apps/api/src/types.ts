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
}
