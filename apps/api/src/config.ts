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
  };
}

function required(v: string | undefined, name: string): string {
  if (!v || v.length === 0) throw new Error(`missing required env var: ${name}`);
  return v;
}
