import { Command } from "commander";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadFolderManifest,
  loadAllHosts,
  createSecretsResolver,
  plan as buildPlan,
  renderCrontab,
} from "@synccenter/apply-planner";
import { compile } from "@synccenter/rule-compiler";
import { resolveScPaths, ScError } from "../lib/config.ts";
import { emit, fail, type OutputCtx } from "../lib/output.ts";

interface CommonOpts {
  config?: string;
  json?: boolean;
}

export function registerScheduleCommand(program: Command): void {
  const sch = program.command("schedule").description("Cron / schedule helpers");

  sch
    .command("render")
    .description(
      "Render the cloud-edge crontab fragment for every folder with a cloud bisync",
    )
    .option("--out <path>", "write to a file instead of stdout")
    .action(async (opts: { out?: string }, cmd: Command) => {
      const ctx = makeCtx(cmd);
      try {
        const paths = resolveScPaths({ explicitDir: globalConfig(cmd) });
        const hosts = loadAllHosts(paths.hostsDir);
        const secrets = createSecretsResolver({ configDir: paths.configDir });

        const folderFiles = readdirSync(paths.foldersDir).filter(
          (f) =>
            f.endsWith(".yaml") &&
            !f.startsWith("example-") &&
            f !== "README.md",
        );

        const allSchedule = [];
        for (const f of folderFiles) {
          const folder = loadFolderManifest(join(paths.foldersDir, f));
          if (!folder.cloud) continue;
          const compiled = compile(
            join(paths.rulesDir, `${folder.ruleset}.yaml`),
            {
              rulesetsDir: paths.rulesDir,
              importsDir: paths.importsDir,
            },
          );
          const filtersFile = join(
            paths.compiledDir,
            folder.ruleset,
            "filter.rclone",
          );
          const p = buildPlan({
            folder,
            hosts,
            compiledIgnoreLines: compiled.stignore.split("\n"),
            filtersFile,
            secrets,
          });
          allSchedule.push(...p.schedule);
        }

        const text = renderCrontab(allSchedule);
        if (opts.out) {
          writeFileSync(opts.out, text, "utf8");
          emit(ctx, `wrote ${text.length} bytes to ${opts.out}`, {
            path: opts.out,
            bytes: text.length,
          });
        } else {
          // For schedule render, the human and JSON outputs differ:
          // human: print the crontab text directly to stdout
          // json: wrap in {crontab: text}
          if (ctx.json) {
            emit(ctx, text, { crontab: text });
          } else {
            process.stdout.write(text);
          }
        }
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
