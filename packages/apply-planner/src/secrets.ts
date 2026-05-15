import { join } from "path";
import { PlanError } from "./errors.ts";
import type { SecretsResolver } from "./types.ts";

export interface SpawnResult {
  stdout: string;
  stderr: string;
  status: number;
}

export interface SecretsResolverOpts {
  configDir: string;
  /** Injectable for tests; defaults to Bun.spawnSync wrapper. */
  spawn?: (argv: string[]) => SpawnResult;
}

export function createSecretsResolver(opts: SecretsResolverOpts): SecretsResolver {
  const cache = new Map<string, string>();
  const spawn = opts.spawn ?? defaultSpawn;
  return {
    resolve(ref: string): string {
      const cached = cache.get(ref);
      if (cached !== undefined) return cached;
      const sep = ref.indexOf("#");
      if (sep === -1) {
        throw new PlanError(
          `SECRET_REF_INVALID: invalid secret ref (missing '#'): ${ref}`,
          "SECRET_REF_INVALID",
        );
      }
      const relPath = ref.slice(0, sep);
      const key = ref.slice(sep + 1);
      const absPath = join(opts.configDir, relPath);
      const argv = ["sops", "-d", "--extract", `["${key}"]`, absPath];
      const res = spawn(argv);
      if (res.status !== 0) {
        throw new PlanError(
          `SOPS_DECRYPT_FAILED: sops failed (exit ${res.status}) for ${ref}: ${res.stderr.trim()}`,
          "SOPS_DECRYPT_FAILED",
        );
      }
      const value = res.stdout.replace(/\n$/, "");
      cache.set(ref, value);
      return value;
    },
  };
}

function defaultSpawn(argv: string[]): SpawnResult {
  const proc = Bun.spawnSync({ cmd: argv, stdout: "pipe", stderr: "pipe" });
  return {
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
    status: proc.exitCode ?? 0,
  };
}
