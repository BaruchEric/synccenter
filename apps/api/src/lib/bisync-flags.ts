/**
 * Translate a folder manifest's `bisync.flags` (written as CLI flags, because
 * that is how the scheduled crontab runs them) into rclone rc parameters.
 *
 * This exists because on-demand Run and the nightly cron leg MUST behave
 * identically. The cron line carries `--modify-window=1s`; the rc call has to
 * carry it too, or the run aborts on the NAS's second-precision modtimes versus
 * Drive's milliseconds — which is exactly how a baruchrio seed died 47 minutes
 * in. Anything this cannot translate is reported, never dropped quietly.
 */

/** Bisync flags that take no value, passed straight through to sync/bisync. */
const BOOL_PARAMS: Record<string, string> = {
  "--resilient": "resilient",
  "--recover": "recover",
  "--force": "force",
  "--create-empty-src-dirs": "createEmptySrcDirs",
  "--remove-empty-dirs": "removeEmptyDirs",
  "--no-cleanup": "noCleanup",
  "--ignore-listing-checksum": "ignoreListingChecksum",
  "--check-access": "checkAccess",
};

/** Bisync flags that take a value. */
const VALUE_PARAMS: Record<string, string> = {
  "--max-lock": "maxLock",
  "--compare": "compare",
  "--conflict-resolve": "conflictResolve",
  "--conflict-loser": "conflictLoser",
  "--conflict-suffix": "conflictSuffix",
  "--check-filename": "checkFilename",
  "--workdir": "workdir",
};

/**
 * Global options, which the rc takes under `_config` using Go field names.
 * Verified applied, not merely accepted: `_config {"DryRun":true}` suppresses a
 * copy that otherwise happens. (`_config` ignores unknown keys silently, so
 * "the daemon accepted it" proves nothing on its own.)
 */
const CONFIG_OPTIONS: Record<string, string> = {
  "--modify-window": "ModifyWindow",
  "--transfers": "Transfers",
  "--checkers": "Checkers",
  "--timeout": "Timeout",
  "--retries": "Retries",
  "--bwlimit": "BwLimit",
};

/**
 * rclone backends whose `--<backend>-<option>` flags we recognise as remote
 * configuration. Matched against a known set rather than by shape: without it,
 * any unrecognised flag of the form `--a-b` would be waved through as "probably
 * a backend option" when it is really a typo or a flag we have not handled.
 */
const BACKENDS = new Set([
  "drive",
  "s3",
  "b2",
  "sftp",
  "ftp",
  "dropbox",
  "onedrive",
  "azureblob",
  "gcs",
  "swift",
  "webdav",
  "crypt",
  "local",
]);

export interface BisyncFlagPlan {
  /** Merged into the sync/bisync request body. */
  params: Record<string, unknown>;
  /** Sent as `_config`. Empty when nothing needs overriding. */
  config: Record<string, unknown>;
  /**
   * Flags that will NOT take effect on this run, with the reason. Surfaced to
   * the caller rather than swallowed — a run that is quietly weaker than its
   * schedule is worse than one that says so.
   */
  warnings: string[];
}

export class BisyncFlagError extends Error {
  constructor(public readonly flags: string[]) {
    super(
      `cannot translate these bisync flags to an rclone rc call: ${flags.join(", ")}. ` +
        `Remove them from the manifest or run this leg from the scheduled crontab instead.`,
    );
    this.name = "BisyncFlagError";
  }
}

export function planBisyncFlags(flags: readonly string[] = []): BisyncFlagPlan {
  const params: Record<string, unknown> = {};
  const config: Record<string, unknown> = {};
  const warnings: string[] = [];
  const untranslatable: string[] = [];

  for (const raw of flags) {
    const flag = raw.trim();
    if (!flag || flag.startsWith("#")) continue;

    // `--name=value` and `--name value` both appear in the wild; only the
    // former can be represented in a YAML list item, so that is what we parse.
    const eq = flag.indexOf("=");
    const name = eq === -1 ? flag : flag.slice(0, eq);
    const value = eq === -1 ? undefined : flag.slice(eq + 1);

    if (name in BOOL_PARAMS) {
      params[BOOL_PARAMS[name]!] = value === undefined ? true : value !== "false";
      continue;
    }
    if (name in VALUE_PARAMS) {
      if (value === undefined) {
        untranslatable.push(`${flag} (expects a value, e.g. ${name}=…)`);
        continue;
      }
      params[VALUE_PARAMS[name]!] = value;
      continue;
    }
    if (name in CONFIG_OPTIONS) {
      if (value === undefined) {
        untranslatable.push(`${flag} (expects a value, e.g. ${name}=…)`);
        continue;
      }
      config[CONFIG_OPTIONS[name]!] = value;
      continue;
    }

    // Backend options (--drive-*, --s3-*, …) configure the remote itself. The
    // rc has no per-call equivalent: the only way to pass one is a connection
    // string on the path, and that changes the path pair, which is what bisync
    // derives its session identity from — an on-demand run would land on a
    // different listing state than the scheduled one and demand a fresh
    // --resync. Set these on the remote in rclone.conf instead.
    const backend = /^--([a-z0-9]+)-[a-z0-9-]+$/.exec(name);
    if (backend && BACKENDS.has(backend[1]!)) {
      warnings.push(
        `${flag} is a ${backend[1]} backend option: rclone reads it from the remote's own ` +
          `entry in rclone.conf, never per call. This run used whatever that entry says — ` +
          `check ${backend[1]} has the matching key set so it matches the scheduled leg.`,
      );
      continue;
    }

    untranslatable.push(flag);
  }

  if (untranslatable.length > 0) throw new BisyncFlagError(untranslatable);
  return { params, config, warnings };
}
