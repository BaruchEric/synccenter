export interface FolderManifest {
  name: string;
  ruleset: string;
  type: string;
  paths: Record<string, string>;
  cloud?: {
    rclone_remote: string;
    remote_path: string;
    bisync?: {
      schedule?: string;
      flags?: string[];
    };
  };
}
