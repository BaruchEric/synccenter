export interface Ruleset {
  name: string;
  description?: string;
  version: number;
  imports?: string[];
  excludes?: string[];
  includes?: string[];
  /**
   * Excludes that outrank every `includes:` negation.
   *
   * Both engines are first-match-wins and the emitters reverse this list, so
   * `includes:` is otherwise unconditionally the highest-priority block — a
   * broad re-include like `!/dev/**​/.github/**` cannot be bounded, and will
   * happily reach into node_modules or any other tree an earlier rule excluded.
   * Patterns listed here are appended last and therefore emit FIRST, so nothing
   * can re-include them.
   */
  hard_excludes?: string[];
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
