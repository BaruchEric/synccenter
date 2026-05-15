#!/usr/bin/env bun
import { Command } from "commander";
import { version as PKG_VERSION } from "../package.json" with { type: "json" };
import { registerRulesCommand } from "./commands/rules.ts";
import { registerFoldersCommand } from "./commands/folders.ts";
import { registerImportsCommand } from "./commands/imports.ts";
import { registerRemoteCommands } from "./commands/remote.ts";
import { registerStateCommand } from "./commands/state.ts";
import { registerScheduleCommand } from "./commands/schedule.ts";

const program = new Command();

program
  .name("sc")
  .description("SyncCenter command-line interface")
  .version(PKG_VERSION)
  .option("--config <dir>", "Path to synccenter-config (overrides SC_CONFIG_DIR)")
  .option("--api <url>", "SyncCenter API base URL (overrides SC_API_URL)")
  .option("--token <token>", "Bearer token (overrides SC_TOKEN / SC_API_TOKEN)")
  .option("--json", "Emit machine-readable JSON instead of human text", false)
  .enablePositionalOptions();

registerRulesCommand(program);
registerFoldersCommand(program);
registerImportsCommand(program);
registerRemoteCommands(program);
registerStateCommand(program);
registerScheduleCommand(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
});
