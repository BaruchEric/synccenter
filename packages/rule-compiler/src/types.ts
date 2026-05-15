export interface Ruleset {
  name: string;
  description?: string;
  version: number;
  imports?: string[];
  excludes?: string[];
  includes?: string[];
  engine_overrides?: {
    syncthing?: { extra?: string[] };
    rclone?: { extra?: string[] };
  };
}

export interface CompileOptions {
  rulesetsDir: string;
  importsDir: string;
  commitSha?: string;
  allowDivergent?: boolean;
  now?: Date;
}

export interface CompileResult {
  stignore: string;
  rcloneFilter: string;
  warnings: string[];
  source: string;
}

export class CompileError extends Error {
  override readonly cause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "CompileError";
    this.cause = cause;
  }
}
