import type { RcloneClient } from "@synccenter/adapters";
import type { Db } from "../db.ts";
import type { EventBus } from "./bus.ts";
import {
  finishRun,
  listActiveRuns,
  recordMiss,
  toView,
  updateProgress,
  type RunRow,
} from "./runs-service.ts";

/** Consecutive failed polls before a run is declared lost. */
const MAX_MISSES = 5;
/** Nothing legitimate runs this long; a row still 'running' after it is stuck. */
const MAX_RUN_MS = 24 * 60 * 60 * 1000;

export interface RunTrackerOpts {
  db: Db;
  bus: EventBus;
  rclone: RcloneClient | null;
  /** Poll period while at least one run is in flight. Default 1000ms. */
  intervalMs?: number;
}

/**
 * Polls the rclone rcd for every in-flight run and writes what it learns to the
 * runs table, announcing each change on the bus.
 *
 * One poller for the whole server, not one per browser: N viewers of the same
 * running bisync cost the daemon exactly one `job/status` + one `core/stats`
 * per second between them.
 *
 * The timer is deliberately NOT started by the constructor — `buildApp` builds
 * a tracker, `index.ts` starts it. Tests get the object without a live handle
 * keeping the process (and the test runner) alive, and can drive `tick()`
 * directly.
 */
export class RunTracker {
  private readonly db: Db;
  private readonly bus: EventBus;
  private readonly rclone: RcloneClient | null;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  /** Set when a completed run still needs its apply_history row written. */
  onFinished?: (run: RunRow) => void;

  constructor({ db, bus, rclone, intervalMs = 1000 }: RunTrackerOpts) {
    this.db = db;
    this.bus = bus;
    this.rclone = rclone;
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.timer || !this.rclone) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    // Never hold the process open on our account.
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** One poll of every active run. Safe to call directly (tests do). */
  async tick(): Promise<void> {
    if (!this.rclone || this.ticking) return;
    const active = listActiveRuns(this.db);
    if (active.length === 0) return;
    this.ticking = true;
    try {
      await Promise.all(active.map((run) => this.pollOne(run)));
    } finally {
      this.ticking = false;
    }
  }

  private async pollOne(run: RunRow): Promise<void> {
    if (Date.now() - new Date(run.started_at).getTime() > MAX_RUN_MS) {
      this.settle(run.id, "failed", `gave up after ${MAX_RUN_MS / 3_600_000}h without finishing`);
      return;
    }
    if (run.jobid == null) {
      this.settle(run.id, "failed", "no rclone job id was recorded for this run");
      return;
    }
    const rclone = this.rclone!;

    let status: Awaited<ReturnType<RcloneClient["jobStatus"]>>;
    try {
      status = await rclone.jobStatus(run.jobid);
    } catch (err) {
      const misses = recordMiss(this.db, run.id);
      if (misses >= MAX_MISSES) {
        this.settle(run.id, "failed", `lost contact with rclone: ${message(err)}`);
      }
      return;
    }

    // Stats are best-effort: losing them costs a progress bar, not the run.
    if (run.stats_group) {
      try {
        const s = await rclone.getStats(run.stats_group);
        updateProgress(this.db, run.id, {
          bytes: num(s.bytes),
          totalBytes: num(s.totalBytes),
          transfers: num(s.transfers),
          checks: num(s.checks),
          listed: num((s as { listed?: number }).listed),
          errors: num(s.errors),
          speed: num(s.speed),
          eta: typeof s.eta === "number" ? s.eta : null,
          current: s.transferring?.[0]?.name ?? null,
        });
      } catch {
        /* keep the last known numbers */
      }
    }

    if (status.finished) {
      // rclone reports failure two ways: `success: false` and a non-empty
      // `error`. Older builds have set one without the other, so trust either.
      const failed = status.success === false || !!status.error;
      this.settle(run.id, failed ? "failed" : "done", status.error || null);
      return;
    }

    const fresh = this.db.query("SELECT * FROM runs WHERE id = ?").get(run.id) as RunRow | null;
    if (fresh) this.bus.emit({ type: "run", run: toView(fresh) });
  }

  private settle(id: number, state: "done" | "failed" | "stopped", error: string | null): void {
    const row = finishRun(this.db, id, state, error);
    if (!row) return;
    this.bus.emit({ type: "run", run: toView(row) });
    this.onFinished?.(row);
  }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
