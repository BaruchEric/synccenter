import { existsSync } from "node:fs";
import { RcloneClient, RcloneError } from "@synccenter/adapters";
import { loadAllHosts, PlanError, resolveBisyncAnchor } from "@synccenter/apply-planner";
import type { ApiConfig } from "../config.ts";
import type { Db } from "../db.ts";
import type { HostRegistry } from "../registry.ts";
import type { EventBus } from "./bus.ts";
import { planBisyncFlags, BisyncFlagError } from "./bisync-flags.ts";
import { parseFolderByName } from "./fs.ts";
import { errorText, type Log } from "./log.ts";
import { rcloneFilterPathForDaemon } from "./plan.ts";
import { startRun, toView, type RunRow, type RunView } from "./runs-service.ts";

export interface BisyncDeps {
  cfg: ApiConfig;
  db: Db;
  registry: HostRegistry;
  rclone: RcloneClient | null;
  bus: EventBus;
  log: Log;
}

export interface StartBisyncOpts {
  /** Which rclone member to sync with; default the folder's first one. */
  member?: string;
  /** Return as soon as rclone has the job; the tracker follows it. */
  async?: boolean;
  dryRun?: boolean;
  resync?: boolean;
  actor: string;
  source: RunRow["source"];
}

export interface BisyncStarted {
  folder: string;
  member: string;
  path1: string;
  path2: string;
  filtersFile: string;
  warnings?: string[];
  /** Present for async starts: the run the tracker is now following. */
  run?: RunView;
  /** rclone's own response — `{ jobid }` when async, the result otherwise. */
  out: Record<string, unknown>;
}

/**
 * A bisync that could not be started. `status` and `body` are the HTTP
 * answer the trigger route sends; `message` is what the log and the ledger
 * say when nobody is waiting on an HTTP response (the Sync-now chain).
 */
export class BisyncStartError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BisyncStartError";
  }
}

/**
 * Trigger `rclone bisync` between a folder's anchor path and one of its
 * rclone members, exactly the way the scheduled crontab leg runs it: same
 * flags, same filter file, same path pair.
 *
 * Lifted out of the route so that the Sync-now chain can run the cloud leg
 * once a sync window closes, without an HTTP request in the middle.
 */
export async function startBisync(
  deps: BisyncDeps,
  folderName: string,
  opts: StartBisyncOpts,
): Promise<BisyncStarted> {
  const { cfg, db, registry, rclone, bus, log } = deps;
  if (!rclone) {
    throw new BisyncStartError("rclone is not configured (set SC_RCLONE_URL)", 503, {
      error: "rclone is not configured (set SC_RCLONE_URL)",
    });
  }
  const m = parseFolderByName(cfg.foldersDir, folderName);
  if (!m) {
    throw new BisyncStartError(`folder not found: ${folderName}`, 404, {
      error: `folder not found: ${folderName}`,
    });
  }
  // rclone members of this folder — engine: rclone hosts appearing in paths.
  const rcloneMembers = Object.keys(m.paths).filter((h) => registry.isRclone(h));
  if (rcloneMembers.length === 0) {
    throw plain(400, `folder ${m.name} has no rclone member in paths`);
  }
  const memberName = opts.member ?? rcloneMembers[0]!;
  if (!rcloneMembers.includes(memberName)) {
    throw plain(
      400,
      `'${memberName}' is not an rclone member of folder ${m.name} — members: ${rcloneMembers.join(", ")}`,
    );
  }
  const member = registry.manifest(memberName)!;
  if (!member.remote) {
    throw plain(500, `host ${memberName} has engine: rclone but no remote`);
  }

  // Find the anchor host — the path on this host is the rcd-local path1.
  // Same resolution rules (and errors) as the planner's schedule step.
  let anchorName: string;
  try {
    anchorName = resolveBisyncAnchor(m, loadAllHosts(cfg.hostsDir)).name;
  } catch (err) {
    throw plain(err instanceof PlanError ? 400 : 500, errorText(err));
  }
  const path1 = m.paths[anchorName]!; // resolver guarantees the anchor is in paths

  // Keyed by ruleset, not folder, and named the way the DAEMON sees it.
  const filter = rcloneFilterPathForDaemon(cfg, m);
  // Only checkable when the daemon shares our filesystem. When it does not,
  // rclone is the backstop: a filters file it cannot open aborts the run
  // outright rather than syncing unfiltered (verified against rclone 1.75).
  if (filter.local && !existsSync(filter.path)) {
    throw plain(
      409,
      `compiled filter.rclone missing at ${filter.path}. Run POST /folders/${m.name}/apply first.`,
    );
  }

  // The scheduled crontab runs this leg with the manifest's flags; an
  // on-demand run that quietly omitted them would be a different operation
  // wearing the same name.
  let flagPlan;
  try {
    flagPlan = planBisyncFlags(m.bisync?.flags);
  } catch (err) {
    if (err instanceof BisyncFlagError) {
      throw new BisyncStartError(err.message, 400, {
        error: { code: "UNSUPPORTED_BISYNC_FLAG", message: err.message },
      });
    }
    throw err;
  }

  const path2 = `${member.remote}:${m.paths[memberName]}`;
  const async = opts.async === true;
  const dryRun = opts.dryRun === true;
  const resync = opts.resync === true;

  // Progress is only readable from a group we name ourselves — rclone's
  // `job/<jobid>` group stays empty for bisync. Unique per trigger so two
  // runs of the same folder never share a counter.
  const statsGroup = `sc/bisync/${m.name}/${crypto.randomUUID().slice(0, 8)}`;

  let out: Record<string, unknown>;
  try {
    out = await rclone.bisync({
      path1,
      path2,
      filtersFile: filter.path,
      statsGroup,
      ...(async ? { async: true } : {}),
      ...(dryRun ? { dryRun: true } : {}),
      ...(resync ? { resync: true } : {}),
      extra: {
        ...flagPlan.params,
        ...(Object.keys(flagPlan.config).length > 0 ? { _config: flagPlan.config } : {}),
      },
    });
  } catch (err) {
    if (err instanceof RcloneError) {
      // rclone says "bisync aborted" and nothing else; the filter it was
      // told to open is the first thing worth checking.
      const message = `${err.message} — rclone was asked to load ${filter.path}${
        filter.local ? "" : " (a path on the rclone host, not this one)"
      }`;
      log.error("bisync", `bisync → ${memberName} did not start: ${err.message}`, {
        folder: m.name,
        host: memberName,
        data: { endpoint: err.endpoint, upstreamStatus: err.status, filtersFile: filter.path },
      });
      throw new BisyncStartError(message, 502, {
        error: message,
        endpoint: err.endpoint,
        upstreamStatus: err.status,
        filtersFile: filter.path,
      });
    }
    throw plain(500, errorText(err));
  }

  const modeNote = `${async ? " async" : ""}${dryRun ? " dryRun" : ""}${resync ? " resync" : ""}`;
  const base = {
    folder: m.name,
    member: memberName,
    path1,
    path2,
    filtersFile: filter.path,
    ...(flagPlan.warnings.length > 0 ? { warnings: flagPlan.warnings } : {}),
    out,
  };

  if (async && typeof out.jobid === "number") {
    // Leave apply_history alone: the tracker writes the row when the job
    // actually ends, with its real result. Recording it here would put a
    // finished-looking event on the timeline for a job still running.
    const run = startRun(db, {
      folder: m.name,
      member: memberName,
      jobid: out.jobid,
      statsGroup,
      actor: opts.actor,
      source: opts.source,
      dryRun,
      resync,
    });
    const view = toView(run);
    bus.emit({ type: "run", run: view });
    log.info("bisync", `bisync → ${memberName} started (run #${run.id}, rclone job ${out.jobid})${modeNote}`, {
      folder: m.name,
      host: memberName,
      data: { runId: run.id, jobid: out.jobid, path1, path2, filtersFile: filter.path, actor: opts.actor },
    });
    return { ...base, run: view };
  }

  // Synchronous: it is already over by the time we get here.
  const note = `path1=${path1} path2=${path2}${modeNote}`;
  db.run(
    `INSERT INTO apply_history (ts, actor, source, target_kind, target_name, payload_hash, result, note)
     VALUES (?, ?, ?, 'folder', ?, ?, ?, ?)`,
    [new Date().toISOString(), opts.actor, opts.source, m.name, "bisync", dryRun ? "dry-run" : "ok", note],
  );
  log.info("bisync", `bisync → ${memberName} finished${modeNote}`, {
    folder: m.name,
    host: memberName,
    data: { path1, path2, actor: opts.actor },
  });
  bus.emit({ type: "folder", folder: m.name, action: "applied" });
  return base;
}

function plain(status: number, message: string): BisyncStartError {
  return new BisyncStartError(message, status, { error: message });
}
