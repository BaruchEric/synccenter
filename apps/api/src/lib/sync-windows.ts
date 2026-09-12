import { join } from "node:path";
import { effectiveSync, loadFolderManifest, type FolderManifest } from "@synccenter/apply-planner";
import type { ApiConfig } from "../config.ts";
import type { Db } from "../db.ts";
import type { HostRegistry } from "../registry.ts";
import type { EventBus } from "./bus.ts";
import { listYamlNames } from "./fs.ts";
import { settleWindowJobs, startJob } from "./jobs-service.ts";
import { errorText, type Log } from "./log.ts";
import { firesBetween } from "./cron-times.ts";
import {
  activeWindowFor,
  finishWindow,
  getWindow,
  listActiveWindows,
  recordWindowMiss,
  startWindow,
  toWindowView,
  updateWindowProgress,
  type WindowRow,
} from "./windows-service.ts";

/** Consecutive failed polls before a window is declared lost. */
const MAX_MISSES = 5;
/**
 * A window must live this long before it may close as done. Unpausing kicks
 * off a scan and an index exchange; for the first stretch the folder reports
 * a clean `idle` because it does not yet KNOW what it is missing. Closing on
 * that idle would sync nothing, reliably.
 */
const MIN_WINDOW_MS = 30_000;
/** Consecutive caught-up polls required before the window closes. */
const SETTLE_TICKS = 2;

/** One folder×member pair that syncs in windows instead of continuously. */
export interface SyncJob {
  folder: string;
  host: string;
  mode: "scheduled" | "manual";
  /** Present only for mode: scheduled. */
  cron?: string;
  maxWindowMinutes: number;
}

export class SyncWindowError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "NOT_A_MEMBER" | "REALTIME_MEMBER" | "ALREADY_OPEN" | "CLOUD_RUNNING",
  ) {
    super(message);
    this.name = "SyncWindowError";
  }
}

export interface SyncWindowEngineOpts {
  cfg: ApiConfig;
  db: Db;
  bus: EventBus;
  registry: HostRegistry;
  /** Where the engine narrates what it does. Optional so tests can stay quiet. */
  log?: Log;
  /** Poll period while at least one window is open. Default 2000ms. */
  intervalMs?: number;
  /** How often the cron schedules are swept. Default 15s. */
  scheduleMs?: number;
  /** How often held members are checked to still be paused. Default 5min. */
  reconcileMs?: number;
  /** Test seam. */
  now?: () => Date;
}

/**
 * Runs the sync windows for scheduled/manual Syncthing members.
 *
 * The contract with the daemon is deliberately narrow: outside a window the
 * folder is PAUSED on that member (the reconciler enforces it), and a window
 * is resume → let Syncthing catch up in both directions → pause again. All the
 * intelligence — when to open, when it is safe to close, what to tell the UI —
 * lives here, where it can be tested against a fake client.
 *
 * Like RunTracker, the timers are NOT started by the constructor — `buildApp`
 * builds the engine, `index.ts` starts it, and tests drive `tick()` /
 * `checkSchedules()` / `reconcile()` by hand.
 */
export class SyncWindowEngine {
  private readonly cfg: ApiConfig;
  private readonly db: Db;
  private readonly bus: EventBus;
  private readonly registry: HostRegistry;
  private readonly log: Log | null;
  private readonly intervalMs: number;
  private readonly scheduleMs: number;
  private readonly reconcileMs: number;
  private readonly now: () => Date;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private ticking = false;
  private sweeping = false;
  /** The minute boundary the schedule sweep has already covered. */
  private sweptUpTo: Date;
  /** Window id → consecutive caught-up polls (see SETTLE_TICKS). */
  private readonly settleCounts = new Map<number, number>();
  /** Host → its daemon's own device ID, so peers can be told apart from self. */
  private readonly myIds = new Map<string, string>();

  constructor(opts: SyncWindowEngineOpts) {
    this.cfg = opts.cfg;
    this.db = opts.db;
    this.bus = opts.bus;
    this.registry = opts.registry;
    this.log = opts.log ?? null;
    this.intervalMs = opts.intervalMs ?? 2000;
    this.scheduleMs = opts.scheduleMs ?? 15_000;
    this.reconcileMs = opts.reconcileMs ?? 5 * 60_000;
    this.now = opts.now ?? (() => new Date());
    this.sweptUpTo = this.now();
  }

  start(): void {
    if (this.timers.length > 0) return;
    this.timers = [
      setInterval(() => void this.tick().catch((e) => this.log?.error("window", errorText(e))), this.intervalMs),
      setInterval(() => void this.checkSchedules().catch((e) => this.log?.error("schedule", errorText(e))), this.scheduleMs),
      setInterval(() => void this.reconcile().catch((e) => this.log?.error("reconcile", errorText(e))), this.reconcileMs),
    ];
    for (const t of this.timers) t.unref?.();
    // Held members must be paused from the first minutes of a boot, not the
    // first reconcile interval — a crashed window may have left one resumed.
    void this.reconcile().catch((e) => this.log?.error("reconcile", errorText(e)));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Every folder×member pair with a non-realtime sync mode. */
  syncJobs(): SyncJob[] {
    const jobs: SyncJob[] = [];
    for (const name of listYamlNames(this.cfg.foldersDir)) {
      if (name.startsWith("example-")) continue;
      let folder: FolderManifest;
      try {
        folder = loadFolderManifest(join(this.cfg.foldersDir, `${name}.yaml`));
      } catch {
        continue; // a broken manifest is the apply path's problem, not the scheduler's
      }
      if (folder.enabled === false) continue;
      for (const host of Object.keys(folder.paths)) {
        if (this.registry.isRclone(host)) continue;
        const sync = effectiveSync(folder, host);
        if (sync.mode === "realtime") continue;
        jobs.push({
          folder: folder.name,
          host,
          mode: sync.mode,
          ...(sync.schedule ? { cron: sync.schedule } : {}),
          maxWindowMinutes: sync.maxWindowMinutes,
        });
      }
    }
    return jobs;
  }

  /**
   * Open a window: record it, resume the folder on that host, kick a rescan.
   * Throws SyncWindowError when the pair is unknown, realtime, or already open.
   *
   * Every window is a leg of a job. A caller running a chain (Sync now)
   * passes its job; a window opened on its own — a schedule firing, a
   * `?cloud=false` press — becomes a one-leg job of its own here, so the
   * history has one shape for everything.
   */
  async open(
    folderName: string,
    host: string,
    via: WindowRow["via"],
    actor: string,
    source: WindowRow["source"],
    opts: { jobId?: number; allowRealtime?: boolean } = {},
  ): Promise<WindowRow> {
    let folder: FolderManifest;
    try {
      folder = loadFolderManifest(join(this.cfg.foldersDir, `${folderName}.yaml`));
    } catch {
      throw new SyncWindowError(`folder not found: ${folderName}`, "NOT_FOUND");
    }
    if (!(host in folder.paths)) {
      throw new SyncWindowError(`${host} is not a member of folder ${folderName}`, "NOT_A_MEMBER");
    }
    const sync = effectiveSync(folder, host);
    if (sync.mode === "realtime" && !opts.allowRealtime) {
      throw new SyncWindowError(
        `${host} syncs ${folderName} in realtime — sync windows apply to scheduled/manual members`,
        "REALTIME_MEMBER",
      );
    }
    if (activeWindowFor(this.db, folderName, host)) {
      throw new SyncWindowError(`a window is already open for ${folderName} on ${host}`, "ALREADY_OPEN");
    }
    // Keep the cloud source stable throughout an upload. This applies to
    // scheduled and manual opens; the post-cloud return opens after settlement.
    if (this.db.query("SELECT id FROM runs WHERE folder = ? AND state = 'running' LIMIT 1").get(folderName)) {
      throw new SyncWindowError(`cloud sync is still running for ${folderName}`, "CLOUD_RUNNING");
    }

    const jobId =
      opts.jobId ??
      startJob(this.db, {
        folder: folderName,
        kind: "window",
        via,
        hosts: [host],
        cloud: [],
        actor,
        source,
        startedAt: this.now(),
      }).id;
    const row = startWindow(this.db, {
      folder: folderName,
      host,
      via,
      maxMinutes: sync.maxWindowMinutes,
      actor,
      source,
      startedAt: this.now(),
      jobId,
    });
    this.announce(row);
    this.bus.emit({ type: "folder", folder: folderName, action: "resumed" });
    this.log?.info(
      "window",
      `sync window #${row.id} opened on ${host} (${via === "schedule" ? "on schedule" : `by ${actor}`}, cap ${sync.maxWindowMinutes}m)`,
      { folder: folderName, host, data: { windowId: row.id, via, actor, maxMinutes: sync.maxWindowMinutes } },
    );

    try {
      const client = this.registry.client(host);
      await client.resumeFolder(folderName);
      // Unpausing restarts the folder, which schedules its own initial scan.
      // The explicit scan covers the folder that was somehow never paused; it
      // BLOCKS until the walk ends, so a client timeout here is routine and the
      // scan keeps running server-side regardless.
      client.scan(folderName).catch(() => {});
    } catch (err) {
      this.close(row.id, "failed", `could not resume: ${errorText(err)}`);
      return getWindow(this.db, row.id)!;
    }
    return row;
  }

  /** End a window early: pause now, record it as stopped. */
  async stopWindow(id: number): Promise<WindowRow | null> {
    const row = getWindow(this.db, id);
    if (!row || row.state !== "running") return row;
    this.close(id, "stopped", null);
    return getWindow(this.db, id);
  }

  /** One poll of every open window. Safe to call directly (tests do). */
  async tick(): Promise<void> {
    if (this.ticking) return;
    const active = listActiveWindows(this.db);
    if (active.length === 0) return;
    this.ticking = true;
    try {
      await Promise.all(active.map((w) => this.pollOne(w)));
    } finally {
      this.ticking = false;
    }
  }

  /** Open windows for every scheduled pair whose cron fired since last sweep. */
  async checkSchedules(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const upTo = this.now();
      const jobs = this.syncJobs();
      for (const job of jobs) {
        if (job.mode !== "scheduled" || !job.cron) continue;
        if (firesBetween(job.cron, this.sweptUpTo, upTo).length === 0) continue;
        if (activeWindowFor(this.db, job.folder, job.host)) continue;
        try {
          await this.open(job.folder, job.host, "schedule", "scheduler", "schedule");
        } catch (err) {
          // An unreachable host at fire time is the next window's problem, but
          // a schedule that silently never fires is exactly what the log is for.
          this.log?.warn("schedule", `could not open the scheduled window on ${job.host}: ${errorText(err)}`, {
            folder: job.folder,
            host: job.host,
            data: { cron: job.cron },
          });
        }
      }
      this.sweptUpTo = upTo;
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Enforce the resting state: any held member with no open window must be
   * paused. Catches boots after a crash mid-window, applies (which create
   * folders unpaused), and modes newly flipped from realtime.
   */
  async reconcile(): Promise<void> {
    for (const job of this.syncJobs()) {
      if (activeWindowFor(this.db, job.folder, job.host)) continue;
      try {
        const client = this.registry.client(job.host);
        const live = await client.getFolder(job.folder);
        if (!live.paused) {
          await client.pauseFolder(job.folder);
          this.bus.emit({ type: "folder", folder: job.folder, action: "paused" });
          this.log?.info("reconcile", `re-paused ${job.folder} on ${job.host}: held member found running outside a window`, {
            folder: job.folder,
            host: job.host,
            data: { mode: job.mode },
          });
        }
      } catch {
        /* host offline or folder not applied yet — nothing to hold */
      }
    }
  }

  private async pollOne(w: WindowRow): Promise<void> {
    const elapsed = this.now().getTime() - new Date(w.started_at).getTime();
    if (elapsed > w.max_minutes * 60_000) {
      this.close(w.id, "timeout", `still catching up after ${w.max_minutes}m — window closed at its cap`);
      return;
    }

    let status;
    try {
      status = await this.registry.client(w.host).getFolderStatus(w.folder);
    } catch (err) {
      if (recordWindowMiss(this.db, w.id) >= MAX_MISSES) {
        this.close(w.id, "failed", `lost contact with ${w.host}: ${errorText(err)}`);
      }
      return;
    }

    const state = String(status.state);
    const localDone =
      state === "idle" && status.needBytes === 0 && status.needFiles === 0 &&
      (status.needTotalItems ?? 0) === 0 && (status.needDirectories ?? 0) === 0 &&
      (status.needSymlinks ?? 0) === 0 && (status.needDeletes ?? 0) === 0 &&
      status.errors === 0 && status.pullErrors === 0 && elapsed >= MIN_WINDOW_MS;

    // Peers only matter once this host has nothing left to pull: the point of
    // the window is also to let the OTHERS fetch what this host accumulated.
    let peersTotal = 0;
    let peersDone = 0;
    let peersKnown = false;
    if (localDone) {
      try {
        ({ peersTotal, peersDone } = await this.peerCompletion(w.host, w.folder));
        peersKnown = true;
      } catch {
        // Unknown peer state cannot establish convergence.
        peersTotal = 0;
        peersDone = 0;
      }
    }

    updateWindowProgress(this.db, w.id, {
      syncState: state,
      globalBytes: status.globalBytes,
      inSyncBytes: status.inSyncBytes,
      needBytes: status.needBytes,
      needFiles: status.needFiles,
      errors: status.errors,
      peersTotal,
      peersDone,
    });

    const caughtUp = localDone && peersKnown && peersDone >= peersTotal;
    const settled = (this.settleCounts.get(w.id) ?? 0) + 1;
    if (caughtUp && settled >= SETTLE_TICKS) {
      this.close(w.id, "done", null);
      return;
    }
    this.settleCounts.set(w.id, caughtUp ? settled : 0);

    const fresh = getWindow(this.db, w.id);
    if (fresh) this.announce(fresh);
  }

  /** How many connected peers exist for this folder, and how many are at 100%. */
  private async peerCompletion(host: string, folder: string): Promise<{ peersTotal: number; peersDone: number }> {
    const client = this.registry.client(host);
    let myId = this.myIds.get(host);
    if (!myId) {
      myId = (await client.getStatus()).myID;
      this.myIds.set(host, myId);
    }
    const [config, conns] = await Promise.all([client.getFolder(folder), client.getConnections()]);
    const peers = config.devices
      .map((d) => d.deviceID)
      .filter((id) => id !== myId);
    const connected = peers.filter((id) => conns.connections[id]?.connected && !conns.connections[id]?.paused);
    const completions = await Promise.all(connected.map((id) => client.getCompletion(folder, id)));
    return {
      peersTotal: peers.length,
      peersDone: completions.filter((c) => c.completion >= 100 && c.needBytes === 0 &&
        c.needItems === 0 && c.needDeletes === 0 &&
        (!c.remoteState || c.remoteState === "valid")).length,
    };
  }

  /**
   * Close a window: pause the folder on its host (whatever the reason for
   * closing), finish the row, and write the ledger entry the timeline reads.
   */
  private close(id: number, state: "done" | "failed" | "timeout" | "stopped", error: string | null): void {
    this.settleCounts.delete(id);
    const row = finishWindow(this.db, id, state, error);
    if (!row) return;
    const shouldPause = this.syncJobs().some((j) => j.folder === row.folder && j.host === row.host);

    // Pause fire-and-forget: the window is over either way, and a host that
    // cannot be paused right now is the reconciler's next customer.
    void (async () => {
      if (!shouldPause) return;
      try {
        await this.registry.client(row.host).pauseFolder(row.folder);
      } catch (err) {
        this.log?.warn("window", `could not re-pause ${row.folder} on ${row.host} after window #${row.id}: ${errorText(err)} — the reconciler will retry`, {
          folder: row.folder,
          host: row.host,
          data: { windowId: row.id },
        });
      }
    })();

    const note =
      state === "done"
        ? `sync window on ${row.host} · ${size(row.global_bytes)} in sync · ${elapsedLabel(row.started_at, row.finished_at)}`
        : `sync window on ${row.host} · ${error ?? state}`;
    const lineLevel = state === "done" || state === "stopped" ? "info" : state === "timeout" ? "warn" : "error";
    this.log?.write({
      level: lineLevel,
      source: "window",
      folder: row.folder,
      host: row.host,
      message:
        state === "done"
          ? `sync window #${row.id} on ${row.host} done: ${size(row.global_bytes)} in sync after ${elapsedLabel(row.started_at, row.finished_at)}${row.peers_total > 0 ? `, ${row.peers_done}/${row.peers_total} peers caught up` : ""}`
          : state === "stopped"
            ? `sync window #${row.id} on ${row.host} closed by hand after ${elapsedLabel(row.started_at, row.finished_at)}`
            : `sync window #${row.id} on ${row.host} ${state}: ${error ?? state}${row.need_files > 0 ? ` (${row.need_files} files / ${size(row.need_bytes)} still needed, last state ${row.sync_state ?? "?"})` : ""}`,
      data: {
        windowId: row.id,
        state,
        via: row.via,
        elapsed: elapsedLabel(row.started_at, row.finished_at),
        globalBytes: row.global_bytes,
        needBytes: row.need_bytes,
        needFiles: row.need_files,
        errors: row.errors,
        syncState: row.sync_state,
      },
    });
    this.db.run(
      `INSERT INTO apply_history (ts, actor, source, target_kind, target_name, payload_hash, result, note)
       VALUES (?, ?, ?, 'folder', ?, 'sync-window', ?, ?)`,
      [
        row.finished_at ?? new Date().toISOString(),
        row.actor,
        row.source === "schedule" ? "api" : row.source,
        row.folder,
        state === "done" ? "ok" : "error",
        note,
      ],
    );

    this.announce(row);
    this.bus.emit({ type: "folder", folder: row.folder, action: shouldPause ? "paused" : "applied" });
    // After the window event, so a chain waiting on this window (Sync now)
    // has queued its cloud leg before the job is asked whether it is over.
    // Every job this window was a leg of, not just the one that opened it:
    // a press onto an open window rides a row it does not own.
    settleWindowJobs(this.db, this.bus, row.id, row.job_id);
  }

  private announce(row: WindowRow): void {
    this.bus.emit({ type: "window", window: toWindowView(row) });
  }
}

function size(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v.toFixed(i === 0 || v >= 100 ? 0 : 1)} ${units[i]}`;
}

function elapsedLabel(from: string, to: string | null): string {
  const ms = new Date(to ?? Date.now()).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
