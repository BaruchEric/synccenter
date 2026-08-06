import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export interface ApiConfig {
  configDir: string;
  rulesDir: string;
  foldersDir: string;
  hostsDir: string;
  importsDir: string;
  compiledDir: string;
  apiToken: string;
  port: number;
  dbPath: string;
  /**
   * Where the rclone daemon can find compiled filter files, expressed in the
   * DAEMON's filesystem, not ours.
   *
   * `filtersFile` is opened by rclone, which normally runs in a different
   * container: here the API sees the config repo at /srv/synccenter-config
   * while the rcd sees the same directory at /share/…/synccenter-config, so a
   * path computed locally means nothing to the process that has to read it.
   * Point this at the directory the scheduled crontab already uses
   * (/config/filters) so on-demand runs and nightly runs read the same file.
   * Unset is correct when both share a filesystem.
   */
  rcloneFiltersDir?: string;
  /**
   * Directory holding the BUILT React dashboard (`apps/web/dist`), served at
   * /app. Unset means no bundle is mounted at all, which is right for tests and
   * for local dev, where Vite serves the SPA on its own port and proxies here.
   *
   * The bundle must be built with `VITE_BASE=/app/` so its asset URLs and the
   * router basename agree with the mount point.
   */
  webDir?: string;
  rclone?: {
    url: string;
    username?: string;
    password?: string;
    bearerToken?: string;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const configDir = required(env.SC_CONFIG_DIR, "SC_CONFIG_DIR");
  const absConfig = isAbsolute(configDir) ? configDir : resolve(process.cwd(), configDir);
  if (!existsSync(absConfig) || !statSync(absConfig).isDirectory()) {
    throw new Error(`SC_CONFIG_DIR is not a directory: ${absConfig}`);
  }
  const apiToken = required(env.SC_API_TOKEN, "SC_API_TOKEN");
  if (apiToken.length < 16) {
    throw new Error("SC_API_TOKEN must be at least 16 characters");
  }
  const port = Number(env.PORT ?? 3000);
  // 0 is permitted (OS-assigned ephemeral port — useful for embedded test harnesses).
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be 0-65535, got ${env.PORT}`);
  }
  const dbPath = env.SC_DB_PATH ?? ":memory:";
  const rcloneFiltersDir = env.SC_RCLONE_FILTERS_DIR;

  const rclone = env.SC_RCLONE_URL
    ? {
        url: env.SC_RCLONE_URL,
        ...(env.SC_RCLONE_USER ? { username: env.SC_RCLONE_USER } : {}),
        ...(env.SC_RCLONE_PASS ? { password: env.SC_RCLONE_PASS } : {}),
        ...(env.SC_RCLONE_BEARER ? { bearerToken: env.SC_RCLONE_BEARER } : {}),
      }
    : undefined;

  return {
    configDir: absConfig,
    rulesDir: resolve(absConfig, "rules"),
    foldersDir: resolve(absConfig, "folders"),
    hostsDir: resolve(absConfig, "hosts"),
    importsDir: resolve(absConfig, "imports"),
    compiledDir: resolve(absConfig, "compiled"),
    apiToken,
    port,
    dbPath,
    ...(rcloneFiltersDir ? { rcloneFiltersDir } : {}),
    ...(env.SC_WEB_DIR ? { webDir: resolve(env.SC_WEB_DIR) } : {}),
    ...(rclone ? { rclone } : {}),
  };
}

function required(v: string | undefined, name: string): string {
  if (!v || v.length === 0) throw new Error(`missing required env var: ${name}`);
  return v;
}
