import { Command } from "commander";
import {
  importFolder,
  importHost,
  importAll,
  type HostInfo,
  type ImportResult,
} from "@synccenter/state-importer";
import { loadAllHosts, createSecretsResolver } from "@synccenter/apply-planner";
import { resolveScPaths, ScError } from "../lib/config.ts";
import { emit, fail, type OutputCtx } from "../lib/output.ts";

interface CommonOpts {
  config?: string;
  json?: boolean;
}

export function registerStateCommand(program: Command): void {
  const state = program
    .command("state")
    .description("Import live mesh state into YAML manifests");
  const im = state.command("import").description("Import live state");

  im.command("folder <name>")
    .description("Import a single folder from the live mesh")
    .option("--write", "write changes to disk (default: diff and exit)", false)
    .action(async (name: string, opts: { write?: boolean }, cmd: Command) => {
      const ctx = makeCtx(cmd);
      try {
        const paths = resolveScPaths({ explicitDir: globalConfig(cmd) });
        const hosts = buildHostInfo(paths.configDir, paths.hostsDir);
        const res = await importFolder(name, {
          configDir: paths.configDir,
          hosts,
          write: opts.write,
        });
        reportResult(ctx, res);
      } catch (err) {
        handle(ctx, err);
      }
    });

  im.command("host <name>")
    .description("Import a single host's live state")
    .option("--write", "write changes to disk", false)
    .action(async (name: string, opts: { write?: boolean }, cmd: Command) => {
      const ctx = makeCtx(cmd);
      try {
        const paths = resolveScPaths({ explicitDir: globalConfig(cmd) });
        const hosts = buildHostInfo(paths.configDir, paths.hostsDir);
        const all = loadAllHosts(paths.hostsDir);
        const m = all[name];
        if (!m) {
          fail(ctx, `unknown host: ${name}`, 2);
        }
        const secrets = createSecretsResolver({ configDir: paths.configDir });
        const target = hosts.find((h) => h.name === name);
        const res = await importHost(
          {
            name: m!.name,
            hostname: m!.hostname,
            os: m!.os,
            apiUrl: target?.apiUrl ?? m!.syncthing.api_url,
            apiKey: target?.apiKey ?? secrets.resolve(m!.syncthing.api_key_ref),
            preserve: {
              role: m!.role,
              syncthing: m!.syncthing,
              ssh: m!.ssh,
              ip: m!.ip,
              rclone: m!.rclone,
            },
          },
          { configDir: paths.configDir, hosts, write: opts.write },
        );
        reportResult(ctx, res);
      } catch (err) {
        handle(ctx, err);
      }
    });

  im.command("all")
    .description("Import all folders and hosts")
    .option("--write", "write changes to disk", false)
    .action(async (opts: { write?: boolean }, cmd: Command) => {
      const ctx = makeCtx(cmd);
      try {
        const paths = resolveScPaths({ explicitDir: globalConfig(cmd) });
        const hosts = buildHostInfo(paths.configDir, paths.hostsDir);
        const results = await importAll({
          configDir: paths.configDir,
          hosts,
          write: opts.write,
        });
        for (const r of results) reportResult(ctx, r);
      } catch (err) {
        handle(ctx, err);
      }
    });
}

function buildHostInfo(configDir: string, hostsDir: string): HostInfo[] {
  const all = loadAllHosts(hostsDir);
  const secrets = createSecretsResolver({ configDir });
  return Object.values(all).map((h) => ({
    name: h.name,
    apiUrl: h.syncthing.api_url,
    apiKey: secrets.resolve(h.syncthing.api_key_ref),
  }));
}

function reportResult(ctx: OutputCtx, r: ImportResult): void {
  const line = `${r.resource.kind}:${r.resource.name} → ${r.status} (${r.path})`;
  if (ctx.json) {
    emit(ctx, JSON.stringify(r, null, 2), r);
  } else {
    emit(ctx, r.diff ? `${line}\n${r.diff}` : line, r);
  }
  if (r.status === "would-change") {
    process.exitCode = 1;
  }
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
