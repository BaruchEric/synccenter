import { Command } from "commander";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  plan as buildPlanFn,
  apply as applyPlan,
  computeDelta,
  loadFolderManifest,
  loadAllHosts,
  createSecretsResolver,
  type AdapterPool,
  type ApplyPlan,
  type SyncthingFolderConfig as PlannerFolderConfig,
} from "@synccenter/apply-planner";
import { compile } from "@synccenter/rule-compiler";
import { SyncthingClient } from "@synccenter/adapters/syncthing";
import { RcloneClient } from "@synccenter/adapters/rclone";
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

  folders
    .command("plan <name>")
    .description("Compile a folder manifest into an ApplyPlan and print it")
    .action(async (name: string, _opts: unknown, cmd: Command) => {
      const ctx = makeCtx(cmd);
      try {
        const p = await buildPlan(name, cmd);
        if (ctx.json) {
          emit(ctx, JSON.stringify(p, null, 2), p);
        } else {
          emit(ctx, formatPlanSummary(p), p);
        }
      } catch (err) {
        handle(ctx, err);
      }
    });

  folders
    .command("apply <name>")
    .description("Apply a folder manifest against the live mesh")
    .option("--dry-run", "compute the plan and the delta, but don't execute", false)
    .option("--prune", "remove folders/devices that exist live but not in the manifest", false)
    .option("--force", "override divergent-field protection", false)
    .action(
      async (
        name: string,
        opts: { dryRun?: boolean; prune?: boolean; force?: boolean },
        cmd: Command,
      ) => {
        const ctx = makeCtx(cmd);
        try {
          const p = await buildPlan(name, cmd);
          const pool = await buildAdapterPool(cmd);
          const live = await collectLiveState(p, pool);
          const delta = computeDelta(p, live);
          if (delta.liveOnly.length > 0 && !opts.prune) {
            fail(
              ctx,
              `DRIFT: live-only folders detected on hosts ${delta.liveOnly
                .map((d) => `${d.host}:${d.folderId}`)
                .join(", ")} — pass --prune to remove.`,
              2,
            );
          }
          if (delta.divergent.length > 0 && !opts.force) {
            const msg = delta.divergent
              .map(
                (d) =>
                  `  ${d.host} ${d.path}: expected ${JSON.stringify(d.expected)} actual ${JSON.stringify(d.actual)}`,
              )
              .join("\n");
            fail(
              ctx,
              `DRIFT: divergent fields:\n${msg}\n  Pass --force to override or run \`sc state import\` to capture into YAML.`,
              2,
            );
          }
          const res = await applyPlan(p, pool, {
            dryRun: opts.dryRun,
            prune: opts.prune,
            force: opts.force,
          });
          if (ctx.json) {
            emit(ctx, JSON.stringify(res, null, 2), res);
          } else {
            const lines = res.hosts.map(
              (h) =>
                `${h.host}: ${h.status}${h.error ? ` (${h.error.code}: ${h.error.message})` : ""}`,
            );
            emit(ctx, lines.join("\n"), res);
          }
        } catch (err) {
          handle(ctx, err);
        }
      },
    );
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

async function buildPlan(name: string, cmd: Command): Promise<ApplyPlan> {
  const paths = resolveScPaths({ explicitDir: globalConfig(cmd) });
  const folder = loadFolderManifest(join(paths.foldersDir, `${name}.yaml`));
  const hosts = loadAllHosts(paths.hostsDir);
  const secrets = createSecretsResolver({ configDir: paths.configDir });
  const compiled = compile(join(paths.rulesDir, `${folder.ruleset}.yaml`), {
    rulesetsDir: paths.rulesDir,
    importsDir: paths.importsDir,
  });
  const ignoreLines = compiled.stignore.split("\n").filter((l) => l && !l.startsWith("#"));
  const filtersFile = join(paths.compiledDir, folder.ruleset, "filter.rclone");
  return buildPlanFn({ folder, hosts, compiledIgnoreLines: ignoreLines, filtersFile, secrets });
}

async function buildAdapterPool(cmd: Command): Promise<AdapterPool> {
  const paths = resolveScPaths({ explicitDir: globalConfig(cmd) });
  const hosts = loadAllHosts(paths.hostsDir);
  const secrets = createSecretsResolver({ configDir: paths.configDir });
  return {
    syncthing: (h: string) => {
      const host = hosts[h];
      if (!host) throw new Error(`unknown host: ${h}`);
      return new SyncthingClient({
        baseUrl: host.syncthing.api_url,
        apiKey: secrets.resolve(host.syncthing.api_key_ref),
      });
    },
    rclone: (h: string) => {
      const host = hosts[h];
      if (!host) throw new Error(`unknown host: ${h}`);
      if (!host.rclone) throw new Error(`host ${h} has no rclone block`);
      const auth = secrets.resolve(host.rclone.auth_ref);
      const colon = auth.indexOf(":");
      if (colon === -1) {
        // Treat as bearer token if there's no user:pass separator.
        return new RcloneClient({ baseUrl: host.rclone.rcd_url, bearerToken: auth });
      }
      return new RcloneClient({
        baseUrl: host.rclone.rcd_url,
        username: auth.slice(0, colon),
        password: auth.slice(colon + 1),
      });
    },
  };
}

async function collectLiveState(
  p: ApplyPlan,
  pool: AdapterPool,
): Promise<Record<string, { folder: PlannerFolderConfig | null; ignores: string[] | null }>> {
  const out: Record<string, { folder: PlannerFolderConfig | null; ignores: string[] | null }> = {};
  for (const host of Object.keys(p.perHost)) {
    const c = pool.syncthing(host);
    let folder: PlannerFolderConfig | null = null;
    let ignores: string[] | null = null;
    try {
      const live = await c.getFolder(p.folder);
      folder = {
        id: live.id,
        label: live.label ?? live.id,
        path: live.path,
        type: live.type,
        devices: live.devices,
        ...(live.ignorePerms !== undefined && { ignorePerms: live.ignorePerms }),
        ...(live.fsWatcherEnabled !== undefined && { fsWatcherEnabled: live.fsWatcherEnabled }),
        ...(live.fsWatcherDelayS !== undefined && { fsWatcherDelayS: live.fsWatcherDelayS }),
        ...(live.paused !== undefined && { paused: live.paused }),
      };
    } catch {
      /* 404 — folder not present on this host */
    }
    if (folder) {
      try {
        const ig = await c.getIgnores(p.folder);
        ignores = ig.ignore ?? [];
      } catch {
        ignores = [];
      }
    }
    out[host] = { folder, ignores };
  }
  return out;
}

function formatPlanSummary(p: ApplyPlan): string {
  const lines: string[] = [`Plan for folder: ${p.folder}`];
  for (const host of Object.keys(p.perHost)) {
    lines.push(`  ${host}: ${p.perHost[host]!.length} ops`);
    for (const op of p.perHost[host]!) lines.push(`    - ${op.kind}`);
  }
  if (p.schedule.length > 0) {
    lines.push(`  schedule:`);
    for (const s of p.schedule) lines.push(`    ${s.cron} on ${s.anchor}`);
  }
  if (p.warnings.length > 0) {
    lines.push(`  warnings:`);
    for (const w of p.warnings) lines.push(`    ${w}`);
  }
  return lines.join("\n");
}
