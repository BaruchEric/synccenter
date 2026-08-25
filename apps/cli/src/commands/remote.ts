import { Command } from "commander";
import { apiFromCmd } from "../lib/api.ts";
import { ScError } from "../lib/config.ts";
import { emit, fail, type OutputCtx } from "../lib/output.ts";

interface CommonOpts {
  json?: boolean;
}

function ctxOf(cmd: Command): OutputCtx {
  return { json: (cmd.optsWithGlobals() as CommonOpts).json === true };
}

function handle(ctx: OutputCtx, err: unknown): never {
  if (err instanceof ScError) fail(ctx, err.message, err.exitCode);
  fail(ctx, err instanceof Error ? err.message : String(err), 1);
}

export function registerRemoteCommands(program: Command): void {
  program
    .command("status")
    .description("Aggregate status: hosts online, folders by state, recent conflicts")
    .action(async (_o: unknown, cmd: Command) => {
      const ctx = ctxOf(cmd);
      try {
        const api = apiFromCmd(cmd);
        const [hosts, folders, conflicts] = await Promise.all([
          api.get<{ hosts: string[] }>("/hosts"),
          api.get<{ folders: string[] }>("/folders"),
          api.get<{ conflicts: unknown[] }>("/conflicts"),
        ]);
        emit(
          ctx,
          [
            `hosts (${hosts.hosts.length}): ${hosts.hosts.join(", ") || "(none)"}`,
            `folders (${folders.folders.length}): ${folders.folders.join(", ") || "(none)"}`,
            `unresolved conflicts: ${conflicts.conflicts.length}`,
          ].join("\n"),
          { hosts: hosts.hosts, folders: folders.folders, conflicts: conflicts.conflicts },
        );
      } catch (err) {
        handle(ctx, err);
      }
    });

  // ---- folder mutations ----

  program
    .command("apply <folder>")
    .description("Apply a folder's compiled .stignore + scan on every Syncthing host")
    .option("--dry-run", "Preview without touching daemons", false)
    .option("--allow-divergent", "Bypass engine-divergence guard", false)
    .action(async (folder: string, o: { dryRun?: boolean; allowDivergent?: boolean }, cmd: Command) => {
      const ctx = ctxOf(cmd);
      try {
        const api = apiFromCmd(cmd);
        const qs = new URLSearchParams();
        if (o.dryRun) qs.set("dryRun", "true");
        if (o.allowDivergent) qs.set("allowDivergent", "true");
        const path = `/folders/${encodeURIComponent(folder)}/apply${qs.toString() ? `?${qs}` : ""}`;
        const result = await api.post(path);
        emit(ctx, JSON.stringify(result, null, 2), result);
      } catch (err) {
        handle(ctx, err);
      }
    });

  program
    .command("pause <folder>")
    .description("Pause a folder on every host")
    .action(async (folder: string, _o: unknown, cmd: Command) => {
      const ctx = ctxOf(cmd);
      try {
        const api = apiFromCmd(cmd);
        const r = await api.post(`/folders/${encodeURIComponent(folder)}/pause`);
        emit(ctx, JSON.stringify(r, null, 2), r);
      } catch (err) {
        handle(ctx, err);
      }
    });

  program
    .command("resume <folder>")
    .description("Resume a folder on every host")
    .action(async (folder: string, _o: unknown, cmd: Command) => {
      const ctx = ctxOf(cmd);
      try {
        const api = apiFromCmd(cmd);
        const r = await api.post(`/folders/${encodeURIComponent(folder)}/resume`);
        emit(ctx, JSON.stringify(r, null, 2), r);
      } catch (err) {
        handle(ctx, err);
      }
    });

  program
    .command("sync <folder>")
    .description(
      "Sync now, every leg: open a window on the folder's scheduled/manual members, then bisync to its cloud members once the windows close",
    )
    .option("--host <host>", "Only this member's window (default: every scheduled/manual member)")
    .option("--no-cloud", "Stop after the sync windows; skip the bisync to cloud members")
    .action(async (folder: string, o: { host?: string; cloud: boolean }, cmd: Command) => {
      const ctx = ctxOf(cmd);
      try {
        const api = apiFromCmd(cmd);
        const qs = new URLSearchParams();
        if (o.host) qs.set("host", o.host);
        if (o.cloud === false) qs.set("cloud", "false");
        const r = await api.post(`/folders/${encodeURIComponent(folder)}/sync${qs.toString() ? `?${qs}` : ""}`);
        emit(ctx, JSON.stringify(r, null, 2), r);
      } catch (err) {
        handle(ctx, err);
      }
    });

  program
    .command("windows")
    .description("List sync windows (open and recent) for scheduled/manual members")
    .option("--limit <n>", "How many to list", "20")
    .action(async (o: { limit?: string }, cmd: Command) => {
      const ctx = ctxOf(cmd);
      try {
        const api = apiFromCmd(cmd);
        const r = await api.get<{
          windows: Array<{
            id: number;
            folder: string;
            host: string;
            state: string;
            phase: string;
            via: string;
            started_at: string;
            finished_at: string | null;
            fraction: number | null;
            need_bytes: number;
          }>;
          activeCount: number;
        }>(`/windows?limit=${encodeURIComponent(o.limit ?? "20")}`);
        const lines = r.windows.map((w) => {
          const pct = w.fraction == null ? "—" : `${Math.round(w.fraction * 100)}%`;
          const live = w.state === "running" ? w.phase : w.state;
          return `#${w.id} ${w.folder} on ${w.host} · ${live} · ${pct} · via ${w.via} · ${w.started_at}`;
        });
        emit(ctx, lines.length ? lines.join("\n") : "(no sync windows recorded)", r);
      } catch (err) {
        handle(ctx, err);
      }
    });

  // ---- bisync ----

  const bisync = program.command("bisync").description("rclone bisync operations");
  bisync
    .command("trigger <folder>")
    .description("Trigger an rclone bisync for the folder")
    .option("--async", "Return immediately with a jobid", false)
    .option("--dry-run", "Show what would happen without changing anything", false)
    .option("--resync", "One-time bootstrap / recovery resync", false)
    .action(async (folder: string, o: { async?: boolean; dryRun?: boolean; resync?: boolean }, cmd: Command) => {
      const ctx = ctxOf(cmd);
      try {
        const api = apiFromCmd(cmd);
        const qs = new URLSearchParams();
        if (o.async) qs.set("async", "true");
        if (o.dryRun) qs.set("dryRun", "true");
        if (o.resync) qs.set("resync", "true");
        const r = await api.post(
          `/folders/${encodeURIComponent(folder)}/bisync${qs.toString() ? `?${qs}` : ""}`,
        );
        emit(ctx, JSON.stringify(r, null, 2), r);
      } catch (err) {
        handle(ctx, err);
      }
    });

  // ---- hosts ----

  program
    .command("host-status <host>")
    .description("Syncthing version + status for a host")
    .action(async (host: string, _o: unknown, cmd: Command) => {
      const ctx = ctxOf(cmd);
      try {
        const api = apiFromCmd(cmd);
        const r = await api.get(`/hosts/${encodeURIComponent(host)}/status`);
        emit(ctx, JSON.stringify(r, null, 2), r);
      } catch (err) {
        handle(ctx, err);
      }
    });

  program
    .command("folder-state <folder>")
    .description("Per-host folder state, aggregated")
    .action(async (folder: string, _o: unknown, cmd: Command) => {
      const ctx = ctxOf(cmd);
      try {
        const api = apiFromCmd(cmd);
        const r = await api.get(`/folders/${encodeURIComponent(folder)}/state`);
        emit(ctx, JSON.stringify(r, null, 2), r);
      } catch (err) {
        handle(ctx, err);
      }
    });

  // ---- conflicts ----

  const conflicts = program.command("conflicts").description("Inspect conflicts");
  conflicts
    .command("list")
    .description("List unresolved conflicts")
    .action(async (_o: unknown, cmd: Command) => {
      const ctx = ctxOf(cmd);
      try {
        const api = apiFromCmd(cmd);
        const r = await api.get<{ conflicts: unknown[] }>("/conflicts");
        emit(ctx, JSON.stringify(r.conflicts, null, 2), r);
      } catch (err) {
        handle(ctx, err);
      }
    });
}
