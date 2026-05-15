import { Command } from "commander";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadChecksums, refreshAll, refreshOne, scanRulesetImports } from "@synccenter/importers";
import { resolveScPaths, ScError } from "../lib/config.ts";
import { emit, fail, type OutputCtx } from "../lib/output.ts";

interface CommonOpts {
  config?: string;
  json?: boolean;
}

export function registerImportsCommand(program: Command): void {
  const imports = program.command("imports").description("Manage ruleset import cache");

  imports
    .command("list")
    .description("Show every import across rulesets with cache state")
    .action(async (_opts: unknown, cmd: Command) => {
      const ctx = makeCtx(cmd);
      try {
        const paths = resolveScPaths({ explicitDir: globalConfig(cmd) });
        const scan = scanRulesetImports(paths.rulesDir);
        const checks = loadChecksums(paths.importsDir);
        const checksMap = new Map(checks.entries.map((e) => [e.uri, e]));
        const rows = scan.imports.map((uri) => {
          const e = checksMap.get(uri);
          const cached = !!e && existsSync(join(paths.importsDir, e.cachePath));
          return {
            uri,
            cached,
            fetchedAt: e?.fetchedAt ?? null,
            bytes: e?.bytes ?? null,
          };
        });
        emit(
          ctx,
          rows
            .map((r) => {
              const isLocalScheme = r.uri.startsWith("ruleset://") || r.uri.startsWith("file://");
              const mark = isLocalScheme ? "·" : r.cached ? "✓" : "✗";
              return `${mark}  ${r.uri}${r.fetchedAt ? `  (${r.fetchedAt})` : ""}`;
            })
            .join("\n"),
          { imports: rows },
        );
      } catch (err) {
        handle(ctx, err);
      }
    });

  imports
    .command("refresh [uri]")
    .description("Refresh one import URI or all of them")
    .option("--force", "Re-fetch even if cached entry is fresh", false)
    .action(async (uri: string | undefined, cmdOpts: { force?: boolean }, cmd: Command) => {
      const ctx = makeCtx(cmd);
      try {
        const paths = resolveScPaths({ explicitDir: globalConfig(cmd) });
        const opts = {
          importsDir: paths.importsDir,
          rulesetsDir: paths.rulesDir,
          force: cmdOpts.force ?? false,
        };
        const results = uri ? [await refreshOne(uri, opts)] : await refreshAll(opts);
        const failed = results.filter((r) => r.status.startsWith("error"));
        emit(
          ctx,
          results
            .map((r) => `${r.status}\t${r.uri}${r.error ? `\t${r.error}` : ""}`)
            .join("\n"),
          { results },
        );
        if (failed.length > 0) process.exit(1);
      } catch (err) {
        handle(ctx, err);
      }
    });
}

function makeCtx(cmd: Command): OutputCtx {
  return { json: (cmd.optsWithGlobals() as CommonOpts).json === true };
}

function globalConfig(cmd: Command): string | undefined {
  return (cmd.optsWithGlobals() as CommonOpts).config;
}

function handle(ctx: OutputCtx, err: unknown): never {
  if (err instanceof ScError) fail(ctx, err.message, err.exitCode);
  if (err instanceof Error) fail(ctx, err.message, 1);
  fail(ctx, String(err), 1);
}
