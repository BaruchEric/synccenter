export type ImportScheme = "github" | "file" | "ruleset" | "url";

export interface ParsedImport {
  uri: string;
  scheme: ImportScheme;
  /** github://github/gitignore/<NAME> → name=<NAME>. */
  githubName?: string;
  /** file:// path (as given; resolution happens later relative to ruleset dir). */
  filePath?: string;
  /** ruleset name */
  rulesetName?: string;
  /** Full https URL for url:// */
  url?: string;
}

export interface ChecksumEntry {
  uri: string;
  sha256: string;
  bytes: number;
  fetchedAt: string;
  cachePath: string; // relative to importsDir
}

export interface ChecksumFile {
  version: 1;
  entries: ChecksumEntry[];
}

export interface RefreshOpts {
  importsDir: string;
  rulesetsDir: string; // used for ruleset:// references and file:// relative paths
  fetch?: typeof fetch;
  /** Hostnames the url:// scheme may fetch from. github:// is always allowed for github.com. */
  allowlist?: string[];
  /** Skip refetch if cached entry is younger than this. Default 7 days. */
  maxAgeMs?: number;
  force?: boolean;
  now?: Date;
}

export type RefreshStatus =
  | "fetched"
  | "cached"
  | "skipped-not-cacheable"
  | "skipped-missing-local"
  | "error-allowlist"
  | "error-fetch"
  | "error-write";

export interface RefreshResult {
  uri: string;
  status: RefreshStatus;
  cachePath?: string;
  sha256?: string;
  bytes?: number;
  fetchedAt?: string;
  error?: string;
}

export class ImporterError extends Error {
  override readonly cause: unknown;
  constructor(
    message: string,
    public readonly code: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "ImporterError";
    this.cause = cause;
  }
}
