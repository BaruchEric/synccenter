import { effectiveSync } from "@synccenter/apply-planner";
import type { ApiConfig } from "../config.ts";
import type { Db } from "../db.ts";
import type { HostRegistry } from "../registry.ts";
import { BisyncStartError, type BisyncStarted, type StartBisyncOpts } from "./bisync-service.ts";
import type { EventBus } from "./bus.ts";
import { parseFolderByName } from "./fs.ts";
import {
  failJobLeg,
  getJob,
  noteJob,
  setCloudPending,
  setJobAfter,
  setJobOpening,
  settleAndAnnounce,
  startJob,
  toJobView,
  type JobView,
} from "./jobs-service.ts";
import { errorText, type Log } from "./log.ts";
import type { RunView } from "./runs-service.ts";
import { SyncWindowError, type SyncWindowEngine } from "./sync-windows.ts";
import { activeWindowFor, getWindow, toWindowView, type WindowRow, type WindowView } from "./windows-service.ts";

export type SyncNowSource = "api" | "cli" | "ui" | "mcp";

export interface SyncNowOpts {
  /** Only this Syncthing member's window; default every held member. */
  host?: string;
  /** Run the cloud leg (bisync to every rclone member). Default true. */
  cloud?: boolean;
  actor: string;
  source: SyncNowSource;
}

/** What happened to the cloud leg when Sync now was asked for. */
export type CloudLeg =
  | {
      /** Waiting for these windows to close, then bisync. */
      status: "queued";
      members: string[];
      after: number[];
    }
  | {
      /** No window stood in the way — bisync is already running. */
      status: "started";
      members: string[];
      runs: RunView[];
      errors: Array<{ member: string; error: string }>;
    };

export interface SyncNowResult {
  folder: string;
  /** Windows opened by this call, plus any that were already open and got adopted. */
  windows: WindowView[];
  failed: Array<{ host: string; error: string }>;
  /** null when the folder has no rclone member or `cloud: false` was passed. */
  cloud: CloudLeg | null;
  /** The job every leg above belongs to — the one id to follow it by. */
  job: JobView;
}

export class SyncNowError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "SyncNowError";
  }
}

export type BisyncStarter = (
  folder: string,
  opts: StartBisyncOpts,
) => Promise<BisyncStarted>;

export interface SyncNowDeps {
  cfg: ApiConfig;
  db: Db;
  bus: EventBus;
  log: Log;
  registry: HostRegistry;
  engine: SyncWindowEngine;
  bisync: BisyncStarter;
}

/** A folder's queued cloud leg: what it waits on, whose job runs it, how to add more. */
interface Chain {
  ids: number[];
  jobId: number;
  /** Wait for these windows too, before the bisync runs. */
  adopt(ids: number[]): void;
}

/**
 * "Sync now" for a whole folder, every leg in order.
 *
 * A folder like baruchrio has two legs: Mac ↔ NAS over Syncthing, where the
 * NAS member only syncs inside windows, and NAS ↔ Drive over rclone bisync,
 * which runs on the NAS. Opening the window alone leaves Drive where it was
 * until the nightly cron. So Sync now opens the window(s), waits for them to
 * close, and then runs the bisync — the same chain the schedules run, on
 * demand and in one press.
 *
 * The wait is an in-memory subscription to the bus: a restart mid-window
 * loses it, which is fine, because the restart also abandons the window.
 */
export class SyncNow {
  private readonly deps: SyncNowDeps;
  /** Folder → the one chain waiting to run its cloud leg. */
  private readonly following = new Map<string, Chain>();

  constructor(deps: SyncNowDeps) {
    this.deps = deps;
  }

  /** The window ids a folder's queued cloud leg is waiting on, if any. */
  queuedAfter(folder: string): number[] | null {
    return this.following.get(folder)?.ids ?? null;
  }

  async run(folderName: string, opts: SyncNowOpts): Promise<SyncNowResult> {
    const { cfg, db, bus, registry, engine, log } = this.deps;
    const m = parseFolderByName(cfg.foldersDir, folderName);
    if (!m) throw new SyncNowError(`folder not found: ${folderName}`, 404, "NOT_FOUND");

    const held = Object.keys(m.paths).filter(
      (h) => !registry.isRclone(h) && effectiveSync(m, h).mode !== "realtime",
    );
    const requested = opts.host ? [opts.host] : held;
    const cloudMembers =
      opts.cloud === false ? [] : Object.keys(m.paths).filter((h) => registry.isRclone(h));

    if (requested.length === 0 && cloudMembers.length === 0) {
      throw new SyncNowError(
        opts.cloud === false
          ? `folder ${m.name} has no scheduled/manual members — every Syncthing member is realtime`
          : `nothing to sync now for ${m.name}: every Syncthing member is realtime and there is no cloud member`,
        400,
        "NOTHING_TO_SYNC",
      );
    }

    log.info("sync", `sync now requested by ${opts.actor}${opts.host ? ` for ${opts.host}` : ""}`, {
      folder: m.name,
      data: { held: requested, cloud: cloudMembers, actor: opts.actor, source: opts.source },
    });

    // A second press while the first chain is still waiting, on the same
    // windows: one cloud leg is enough, and it is already spoken for. Ride
    // the first press's job rather than minting an empty one.
    const alreadyQueued = this.following.get(m.name);
    if (alreadyQueued && cloudMembers.length > 0) {
      const open = requested.map((host) => activeWindowFor(db, m.name, host));
      const riding = getJob(db, alreadyQueued.jobId);
      if (riding && open.every((w) => w !== null)) {
        // Windows this press found open that the chain is not waiting on yet
        // (another press opened them): the cloud leg belongs behind those too.
        alreadyQueued.adopt(open.filter((w): w is WindowRow => w !== null).map((w) => w.id));
        return {
          folder: m.name,
          windows: open.filter((w): w is WindowRow => w !== null).map(toWindowView),
          failed: [],
          cloud: { status: "queued", members: cloudMembers, after: alreadyQueued.ids },
          job: toJobView(db, riding),
        };
      }
    }

    const job = startJob(db, {
      folder: m.name,
      kind: requested.length > 0 && cloudMembers.length > 0 ? "sync" : cloudMembers.length > 0 ? "bisync" : "window",
      via: "manual",
      hosts: requested,
      cloud: cloudMembers,
      actor: opts.actor,
      source: opts.source,
    });
    // Opening a window can also close it: a resume that fails closes the row
    // from inside open(), and that close settles the job — while this loop is
    // still about to open the next host under the same id. Held, the job waits
    // for the whole set, whether or not there is a cloud leg behind it.
    setJobOpening(db, job.id, true);
    // The cloud leg is planned but has no row yet: the job must not settle on
    // the strength of the windows alone.
    if (cloudMembers.length > 0) setCloudPending(db, job.id, true);

    const windows: WindowRow[] = [];
    const failed: SyncNowResult["failed"] = [];
    for (const host of requested) {
      try {
        windows.push(await engine.open(m.name, host, "manual", opts.actor, opts.source, { jobId: job.id }));
      } catch (err) {
        if (err instanceof SyncWindowError && err.code === "ALREADY_OPEN") {
          // Pressing Sync now on a folder already mid-window is not a mistake;
          // ride the window that is open and chain the cloud leg behind it.
          const open = activeWindowFor(db, m.name, host);
          if (open) {
            windows.push(open);
            continue;
          }
        }
        // A single, explicit host that cannot be opened and no cloud leg to
        // fall through to: the caller asked for one thing and it did not happen.
        if (err instanceof SyncWindowError && requested.length === 1 && cloudMembers.length === 0) {
          failJobLeg(db, job.id, `window on ${host}: ${err.message}`);
          setJobOpening(db, job.id, false);
          settleAndAnnounce(db, bus, job.id);
          throw new SyncNowError(err.message, windowErrorStatus(err), err.code);
        }
        failed.push({ host, error: errorText(err) });
        failJobLeg(db, job.id, `window on ${host}: ${errorText(err)}`);
      }
    }
    // Every leg that is going to exist now does; from here a close may settle.
    setJobOpening(db, job.id, false);
    // Windows this job rides on but did not open belong to the route too.
    const adopted = windows.filter((w) => w.job_id !== job.id).map((w) => w.id);
    // Read the folder's queued chain again rather than trusting the capture
    // from before the opens: another press can have queued the cloud leg while
    // this one waited on resumeFolder, and two chains following the same
    // windows would each run the bisync when they close.
    const queued = this.following.get(m.name);

    let cloud: CloudLeg | null = null;
    if (cloudMembers.length > 0) {
      const pending = windows.filter((w) => w.state === "running").map((w) => w.id);
      setJobAfter(db, job.id, [...new Set([...adopted, ...pending])]);
      if (pending.length === 0) {
        cloud = await this.startCloudLeg(m.name, cloudMembers, opts, job.id);
      } else if (queued) {
        // The windows we just opened are new, but another chain on this
        // folder is already waiting to run the cloud leg; it will cover us.
        // Ours are new windows: the queued chain has to wait for them too, or
        // Drive is written before this press's members have caught up.
        queued.adopt(pending);
        cloud = { status: "queued", members: cloudMembers, after: [...queued.ids] };
        noteJob(db, job.id, `cloud leg already queued by job #${queued.jobId}`);
        setCloudPending(db, job.id, false);
      } else {
        cloud = { status: "queued", members: cloudMembers, after: pending };
        log.info(
          "sync",
          `cloud leg queued: bisync → ${cloudMembers.join(", ")} once the window${pending.length > 1 ? "s" : ""} on ${windows
            .filter((w) => pending.includes(w.id))
            .map((w) => w.host)
            .join(", ")} close${pending.length > 1 ? "" : "s"}`,
          { folder: m.name, data: { after: pending, members: cloudMembers, jobId: job.id } },
        );
        this.followWindows(m.name, pending, cloudMembers, opts, job.id);
      }
    } else if (adopted.length > 0) {
      setJobAfter(db, job.id, adopted);
    }
    // A job whose every leg already ended (a window that failed at resume,
    // a bisync that did not start) closes now rather than at the next event.
    settleAndAnnounce(db, bus, job.id);

    return {
      folder: m.name,
      windows: windows.map((w) => getWindow(db, w.id) ?? w).map(toWindowView),
      failed,
      cloud,
      job: toJobView(db, getJob(db, job.id) ?? job),
    };
  }

  /**
   * Run the cloud leg after the given windows have all closed. Skipped when
   * one of them was closed by hand: stopping a window is the operator saying
   * "not now", and a bisync that fires anyway would be the opposite of that.
   */
  private followWindows(folder: string, ids: number[], members: string[], opts: SyncNowOpts, jobId: number): void {
    const { db, bus, log } = this.deps;
    // Mutated in place by adopt(), and handed out as the chain's `ids`, so
    // queuedAfter and every result that reports `after` see the additions.
    const waiting = [...ids];
    const pending = new Set(ids);
    let stoppedOn: string | null = null;
    let done = false;
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      if (done) return;
      done = true;
      this.following.delete(folder);
      unsubscribe();
      if (timer) clearTimeout(timer);
    };

    const settle = (w: WindowRow) => {
      if (!pending.has(w.id) || w.state === "running") return;
      pending.delete(w.id);
      if (w.state === "stopped") stoppedOn = w.host;
      if (pending.size > 0) return;
      finish();
      if (stoppedOn) {
        log.warn("sync", `cloud leg skipped: the window on ${stoppedOn} was closed by hand`, {
          folder,
          host: stoppedOn,
          data: { members, jobId },
        });
        noteJob(db, jobId, `cloud leg skipped: the window on ${stoppedOn} was closed by hand`);
        setCloudPending(db, jobId, false);
        settleAndAnnounce(db, bus, jobId);
        return;
      }
      // The job can have ended while its windows ran — stopped from the
      // dashboard, most of all. Starting its bisync now would undo the stop.
      const job = getJob(db, jobId);
      if (!job || job.state !== "running") {
        log.warn("sync", `cloud leg skipped: job #${jobId} is ${job?.state ?? "gone"}`, {
          folder,
          data: { members, jobId },
        });
        setCloudPending(db, jobId, false);
        return;
      }
      void this.startCloudLeg(folder, members, opts, jobId);
    };

    /**
     * The windows end at their cap; well past that the subscription is a leak,
     * not a wait. Re-armed when adopt() brings in a window with a longer cap,
     * so the timer never fires on a window that is still legitimately open.
     */
    const arm = () => {
      if (timer) clearTimeout(timer);
      const capMinutes = Math.max(...waiting.map((id) => getWindow(db, id)?.max_minutes ?? 60));
      timer = setTimeout(
        () => {
          if (done) return;
          if (waiting.some((id) => {
            const w = getWindow(db, id);
            return w?.state === "running" && Date.now() < new Date(w.started_at).getTime() + (w.max_minutes + 5) * 60_000;
          })) { arm(); return; }
          finish();
          log.warn("sync", `cloud leg abandoned: window${pending.size > 1 ? "s" : ""} #${[...pending].join(", #")} never reported closing`, {
            folder,
            data: { members, after: [...waiting], jobId },
          });
          for (const member of members) {
            failJobLeg(db, jobId, `bisync → ${member} abandoned: the windows never reported closing`);
          }
          setCloudPending(db, jobId, false);
          settleAndAnnounce(db, bus, jobId);
        },
        (capMinutes + 5) * 60_000,
      );
      timer.unref?.();
    };

    const adopt = (more: number[]) => {
      if (done) return;
      const fresh = more.filter((id) => !waiting.includes(id));
      if (fresh.length === 0) return;
      for (const id of fresh) {
        waiting.push(id);
        pending.add(id);
      }
      arm();
      // One of them may already have closed; the same catch-up the initial
      // subscription does, or the chain would wait for an event never coming.
      for (const id of fresh) {
        const now = getWindow(db, id);
        if (now) settle(now);
      }
    };

    this.following.set(folder, { ids: waiting, jobId, adopt });

    unsubscribe = bus.subscribe((e) => {
      if (e.type === "window" && e.window.folder === folder) settle(e.window);
    });
    arm();

    // A window can have closed between open() returning and this subscription
    // (a resume that failed closes the row before open() even returns).
    for (const id of ids) {
      const now = getWindow(db, id);
      if (now) settle(now);
    }
  }

  private async startCloudLeg(
    folder: string,
    members: string[],
    opts: SyncNowOpts,
    jobId: number,
  ): Promise<CloudLeg> {
    const { db, bus, log } = this.deps;
    const runs: RunView[] = [];
    const errors: Array<{ member: string; error: string }> = [];
    const job = getJob(db, jobId);
    const own = db.query("SELECT * FROM sync_windows WHERE job_id = ?").all(jobId) as WindowRow[];
    const adopted = (JSON.parse(job?.after ?? "[]") as number[]).map((id) => getWindow(db, id));
    let blocked = !job || job.legs_failed > 0 || [...own, ...adopted].some((w) => !w || w.state !== "done");
    const manifest = parseFolderByName(this.deps.cfg.foldersDir, folder);
    // Realtime members have no window row. Check their actual state too.
    if (!manifest) blocked = true;
    if (!blocked && manifest) {
      for (const host of Object.keys(manifest.paths)) {
        if (this.deps.registry.isRclone(host) || effectiveSync(manifest, host).mode !== "realtime") continue;
        try {
          const s = await this.deps.registry.client(host).getFolderStatus(folder);
          if (s.state !== "idle" || s.needBytes !== 0 || s.needFiles !== 0 || s.errors !== 0 ||
            s.pullErrors !== 0 || (s.needTotalItems ?? 0) !== 0 || (s.needDeletes ?? 0) !== 0 ||
            (s.needDirectories ?? 0) !== 0 || (s.needSymlinks ?? 0) !== 0 || s.sequence === 0) blocked = true;
        } catch { blocked = true; }
      }
    }
    if (blocked) {
      const error = "cloud leg blocked: required mesh members did not complete successfully";
      for (const member of members) {
        errors.push({ member, error });
        failJobLeg(db, jobId, `bisync → ${member}: ${error}`);
      }
      log.warn("sync", error, { folder, data: { jobId } });
      setCloudPending(db, jobId, false);
      settleAndAnnounce(db, bus, jobId);
      return { status: "started", members, runs, errors };
    }
    for (const member of members) {
      try {
        const started = await this.deps.bisync(folder, {
          member,
          async: true,
          actor: opts.actor,
          source: opts.source,
          jobId,
        });
        if (started.run) runs.push(started.run);
      } catch (err) {
        const message = err instanceof BisyncStartError ? err.message : errorText(err);
        errors.push({ member, error: message });
        failJobLeg(db, jobId, `bisync → ${member} did not start: ${message}`);
        // A leg that never left the ground still belongs in the ledger: the
        // whole point of the chain is that "Sync now" means Drive too, and a
        // silently missing bisync is the failure this feature exists to end.
        log.error("sync", `cloud leg did not start: bisync → ${member}: ${message}`, {
          folder,
          host: member,
          data: { actor: opts.actor },
        });
        db.run(
          `INSERT INTO apply_history (ts, actor, source, target_kind, target_name, payload_hash, result, note)
           VALUES (?, ?, ?, 'folder', ?, 'bisync', 'error', ?)`,
          [new Date().toISOString(), opts.actor, opts.source, folder, `bisync → ${member} did not start: ${message}`],
        );
        bus.emit({ type: "folder", folder, action: "applied" });
      }
    }
    setCloudPending(db, jobId, false);
    settleAndAnnounce(db, bus, jobId);
    return { status: "started", members, runs, errors };
  }
}

/** Shared with the routes: map a SyncWindowError onto an HTTP status. */
export function windowErrorStatus(err: SyncWindowError): number {
  switch (err.code) {
    case "NOT_FOUND":
      return 404;
    case "ALREADY_OPEN":
      return 409;
    default:
      return 400;
  }
}
