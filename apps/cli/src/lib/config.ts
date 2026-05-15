import { existsSync, statSync } from "node:fs";
import { resolve, dirname, isAbsolute, sep } from "node:path";

export interface ScPaths {
  configDir: string;
  rulesDir: string;
  foldersDir: string;
  hostsDir: string;
  importsDir: string;
  schedulesDir: string;
  compiledDir: string;
}

export interface ResolveOpts {
  explicitDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Locate the synccenter-config directory. Precedence:
 *   1. --config <dir> CLI flag (explicitDir)
 *   2. $SC_CONFIG_DIR
 *   3. sibling `../synccenter-config` walking up from cwd until found
 *   4. error with actionable hint
 */
export function resolveScPaths(opts: ResolveOpts = {}): ScPaths {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();

  const candidate = opts.explicitDir ?? env.SC_CONFIG_DIR ?? findSibling(cwd);

  if (!candidate) {
    throw new ScError(
      "couldn't find synccenter-config. Pass --config <dir> or set $SC_CONFIG_DIR.",
      2,
    );
  }
  const configDir = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
  if (!isDir(configDir)) {
    throw new ScError(`synccenter-config dir does not exist: ${configDir}`, 2);
  }

  return {
    configDir,
    rulesDir: resolve(configDir, "rules"),
    foldersDir: resolve(configDir, "folders"),
    hostsDir: resolve(configDir, "hosts"),
    importsDir: resolve(configDir, "imports"),
    schedulesDir: resolve(configDir, "schedules"),
    compiledDir: resolve(configDir, "compiled"),
  };
}

function findSibling(start: string): string | undefined {
  let dir = start;
  for (;;) {
    const candidate = resolve(dir, "..", "synccenter-config");
    if (isDir(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
    if (dir === sep) return undefined;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export class ScError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number = 1,
  ) {
    super(message);
    this.name = "ScError";
  }
}
