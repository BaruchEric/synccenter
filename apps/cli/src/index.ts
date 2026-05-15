#!/usr/bin/env bun
import { Command } from "commander";
import { registerRulesCommand } from "./commands/rules.ts";
import { registerFoldersCommand } from "./commands/folders.ts";
import { registerImportsCommand } from "./commands/imports.ts";
import { registerPlaceholders } from "./commands/placeholders.ts";

const program = new Command();

program
  .name("sc")
  .description("SyncCenter command-line interface")
  .version("0.0.1")
  .option("--config <dir>", "Path to synccenter-config (overrides SC_CONFIG_DIR)")
  .option("--json", "Emit machine-readable JSON instead of human text", false)
  .enablePositionalOptions();

registerRulesCommand(program);
registerFoldersCommand(program);
registerImportsCommand(program);
registerPlaceholders(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
});
