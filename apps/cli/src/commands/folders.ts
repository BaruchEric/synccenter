import { Command } from "commander";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveScPaths, ScError } from "../lib/config.ts";
import { emit, fail, type OutputCtx } from "../lib/output.ts";

interface CommonOpts {
  config?: string;
  json?: boolean;
}

export function registerFoldersCommand(program: Command): void {
  const folders = program.command("folders").description("Manage folder definitions");

  folders
    .command("list")
    .description("List folders defined in the config repo")
    .action((_opts: unknown, cmd: Command) => {
      const ctx = makeCtx(cmd);
      try {
        const paths = resolveScPaths({ explicitDir: globalConfig(cmd) });
        const names = readdirSync(paths.foldersDir)
          .filter((f) => f.endsWith(".yaml"))
          .map((f) => basename(f, ".yaml"))
          .sort();
        emit(ctx, names.length ? names.join("\n") : "(no folders)", { folders: names });
      } catch (err) {
        handle(ctx, err);
      }
    });

  folders
    .command("get <name>")
    .description("Print a parsed folder definition")
    .action((name: string, _opts: unknown, cmd: Command) => {
      const ctx = makeCtx(cmd);
      try {
        const paths = resolveScPaths({ explicitDir: globalConfig(cmd) });
        const path = join(paths.foldersDir, `${name}.yaml`);
        let raw: string;
        try {
          raw = readFileSync(path, "utf8");
        } catch {
          fail(ctx, `folder not found: ${name} (looked for ${path})`, 2);
        }
        const parsed = parseYaml(raw) as unknown;
        emit(ctx, JSON.stringify(parsed, null, 2), parsed);
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
