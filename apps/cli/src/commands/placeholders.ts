import type { Command } from "commander";

const PHASE_3 = "needs the SyncCenter API (Phase 3) — not yet implemented";

export function registerPlaceholders(program: Command): void {
  program
    .command("status")
    .description(`Show devices, folders, conflicts (${PHASE_3})`)
    .action(notYet);

  const conflicts = program.command("conflicts").description(`Manage conflicts (${PHASE_3})`);
  conflicts.command("list").description(PHASE_3).action(notYet);
  conflicts
    .command("resolve <id>")
    .description(PHASE_3)
    .option("--strategy <s>", "newer | older | both | manual")
    .action(notYet);

  program.command("pause <folder>").description(`Pause a folder (${PHASE_3})`).action(notYet);
  program.command("resume <folder>").description(`Resume a folder (${PHASE_3})`).action(notYet);

  const bisync = program.command("bisync").description(`rclone bisync ops (${PHASE_3})`);
  bisync.command("trigger <folder>").description(PHASE_3).action(notYet);

  program
    .command("apply <file>")
    .description(`Apply a folder change to live hosts (${PHASE_3})`)
    .option("--dry-run", "Show diff without applying")
    .action(notYet);
}

function notYet(): never {
  process.stderr.write(`error: ${PHASE_3}\n`);
  process.exit(2);
}
