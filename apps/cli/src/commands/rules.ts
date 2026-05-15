import { Command } from "commander";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { compile, loadRuleset } from "@synccenter/rule-compiler";
import { resolveScPaths, ScError } from "../lib/config.ts";
import { gitShortSha } from "../lib/git.ts";
import { emit, fail, type OutputCtx } from "../lib/output.ts";

interface CommonOpts {
  config?: string;
  json?: boolean;
}

export function registerRulesCommand(program: Command): void {
  const rules = program
    .command("rules")
    .description("Manage rulesets (list, compile, preview)");

  rules
    .command("list")
    .description("List rulesets in the config repo")
    .action((_opts: unknown, cmd: Command) => {
      const ctx = makeCtx(cmd);
      try {
        const paths = resolveScPaths({ explicitDir: globalConfig(cmd) });
        const names = listRulesets(paths.rulesDir);
        emit(ctx, names.length ? names.join("\n") : "(no rulesets)", { rulesets: names });
      } catch (err) {
        handle(ctx, err);
      }
    });

  rules
    .command("compile <name>")
    .description("Compile a ruleset and write to compiled/<name>/")
    .option("--allow-divergent", "Emit even when patterns diverge between engines", false)
    .option("--stdout", "Print to stdout instead of writing files", false)
    .action((name: string, cmdOpts: { allowDivergent?: boolean; stdout?: boolean }, cmd: Command) => {
      const ctx = makeCtx(cmd);
      try {
        const paths = resolveScPaths({ explicitDir: globalConfig(cmd) });
        const rulesetPath = join(paths.rulesDir, `${name}.yaml`);
        const result = compile(rulesetPath, {
          rulesetsDir: paths.rulesDir,
          importsDir: paths.importsDir,
          commitSha: gitShortSha(paths.configDir),
          allowDivergent: cmdOpts.allowDivergent ?? false,
        });

        if (cmdOpts.stdout) {
          emit(
            ctx,
            `=== .stignore ===\n${result.stignore}\n=== filter.rclone ===\n${result.rcloneFilter}`,
            { ...result, written: false },
          );
          return;
        }

        const outDir = join(paths.compiledDir, name);
        mkdirSync(outDir, { recursive: true });
        const stignorePath = join(outDir, ".stignore");
        const rclonePath = join(outDir, "filter.rclone");
        writeFileSync(stignorePath, result.stignore);
        writeFileSync(rclonePath, result.rcloneFilter);

        emit(
          ctx,
          [
            `compiled ${name}:`,
            `  ${stignorePath}`,
            `  ${rclonePath}`,
            result.warnings.length ? `  warnings: ${result.warnings.length}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
          {
            name,
            written: [stignorePath, rclonePath],
            warnings: result.warnings,
          },
        );
      } catch (err) {
        handle(ctx, err);
      }
    });

  rules
    .command("preview <name>")
    .description("Compile and print to stdout without writing files")
    .option("--allow-divergent", "Emit even when patterns diverge between engines", false)
    .action((name: string, cmdOpts: { allowDivergent?: boolean }, cmd: Command) => {
      const ctx = makeCtx(cmd);
      try {
        const paths = resolveScPaths({ explicitDir: globalConfig(cmd) });
        const result = compile(join(paths.rulesDir, `${name}.yaml`), {
          rulesetsDir: paths.rulesDir,
          importsDir: paths.importsDir,
          commitSha: gitShortSha(paths.configDir),
          allowDivergent: cmdOpts.allowDivergent ?? false,
        });
        emit(
          ctx,
          `=== .stignore ===\n${result.stignore}\n=== filter.rclone ===\n${result.rcloneFilter}`,
          result,
        );
      } catch (err) {
        handle(ctx, err);
      }
    });

  rules
    .command("show <name>")
    .description("Print the parsed ruleset (post-validation, pre-import-resolution)")
    .action((name: string, _opts: unknown, cmd: Command) => {
      const ctx = makeCtx(cmd);
      try {
        const paths = resolveScPaths({ explicitDir: globalConfig(cmd) });
        const ruleset = loadRuleset(join(paths.rulesDir, `${name}.yaml`));
        emit(ctx, JSON.stringify(ruleset, null, 2), ruleset);
      } catch (err) {
        handle(ctx, err);
      }
    });
}

function listRulesets(rulesDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(rulesDir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(".yaml") && f !== "README.md")
    .map((f) => basename(f, ".yaml"))
    .sort();
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
