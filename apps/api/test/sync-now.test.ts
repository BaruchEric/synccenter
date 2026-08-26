import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SyncthingClient } from "@synccenter/adapters";
import { loadConfig, type ApiConfig } from "../src/config.ts";
import { openDb, type Db } from "../src/db.ts";
import { BisyncStartError, type BisyncStarted, type StartBisyncOpts } from "../src/lib/bisync-service.ts";
import { EventBus } from "../src/lib/bus.ts";
import { Log, type LogLine } from "../src/lib/log.ts";
import { HostRegistry } from "../src/registry.ts";
import { abandonStaleJobs, getJob, settleJob, startJob, stopJob, toJobView } from "../src/lib/jobs-service.ts";
import { finishRun, getRun, listRunsForJobs, startRun, toView } from "../src/lib/runs-service.ts";
import { SyncNow, SyncNowError } from "../src/lib/sync-now.ts";
import { SyncWindowEngine } from "../src/lib/sync-windows.ts";
import { activeWindowFor, finishWindow, getWindow, startWindow } from "../src/lib/windows-service.ts";
import { FakeDaemon } from "./helpers/fake-daemon.ts";

const TOKEN = "test-token-of-sufficient-length-1234567890";

let tmpRoot: string;
let cfg: ApiConfig;
let db: Db;
let bus: EventBus;
let log: Log;
let qnap: FakeDaemon;
let mac: FakeDaemon;
let engine: SyncWindowEngine;
let syncNow: SyncNow;
let clock: Date;
/** Every bisync the chain asked for, in order. */
let bisyncCalls: Array<{ folder: string; opts: StartBisyncOpts }>;
/** Set to make the next bisync refuse to start. */
let bisyncFails: BisyncStartError | null;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "synccenter-sync-now-"));
  const configDir = join(tmpRoot, "config");
  for (const sub of ["rules", "folders", "hosts", "imports", "schedules", "compiled"]) {
    mkdirSync(join(configDir, sub), { recursive: true });
  }
  writeFileSync(
    join(configDir, "rules", "base-binaries.yaml"),
    "name: base-binaries\nversion: 1\nexcludes:\n  - .DS_Store\n",
  );
  // baruchrio's shape: the Mac realtime, the NAS in windows, Drive via bisync.
  writeFileSync(
    join(configDir, "folders", "cloudy.yaml"),
    [
      "name: cloudy",
      "ruleset: base-binaries",
      "type: send-receive",
      "paths:",
      "  mac-studio: /Users/eric/Sync/cloudy",
      "  qnap-ts453d: /share/Sync/cloudy",
      "  gdrive: sync/cloudy",
      'bisync: { schedule: "0 4 * * *" }',
      "overrides:",
      "  qnap-ts453d:",
      "    sync:",
      "      mode: scheduled",
      '      schedule: "0 * * * *"',
      "      max_window_minutes: 45",
    ].join("\n"),
  );
  // Two members that both sync in windows, and no cloud member: a press here
  // opens two windows under one job and has no bisync to wait for.
  writeFileSync(
    join(configDir, "folders", "two-held.yaml"),
    [
      "name: two-held",
      "ruleset: base-binaries",
      "type: send-receive",
      "paths:",
      "  mac-studio: /Users/eric/Sync/two-held",
      "  qnap-ts453d: /share/Sync/two-held",
      "sync:",
      "  mode: manual",
    ].join("\n"),
  );
  // The same two held members, with Drive behind them: the bisync has to wait
  // for BOTH windows, however many presses opened them.
  writeFileSync(
    join(configDir, "folders", "two-held-cloud.yaml"),
    [
      "name: two-held-cloud",
      "ruleset: base-binaries",
      "type: send-receive",
      "paths:",
      "  mac-studio: /Users/eric/Sync/two-held-cloud",
      "  qnap-ts453d: /share/Sync/two-held-cloud",
      "  gdrive: sync/two-held-cloud",
      'bisync: { schedule: "0 4 * * *" }',
      "sync:",
      "  mode: manual",
    ].join("\n"),
  );
  // Everything realtime, plus Drive: nothing to wait for before the bisync.
  writeFileSync(
    join(configDir, "folders", "cloud-only.yaml"),
    [
      "name: cloud-only",
      "ruleset: base-binaries",
      "type: send-receive",
      "paths:",
      "  mac-studio: /Users/eric/Sync/cloud-only",
      "  qnap-ts453d: /share/Sync/cloud-only",
      "  gdrive: sync/cloud-only",
    ].join("\n"),
  );
  // Realtime mesh, no cloud: Sync now has nothing to do.
  writeFileSync(
    join(configDir, "folders", "live.yaml"),
    [
      "name: live",
      "ruleset: base-binaries",
      "type: send-receive",
      "paths:",
      "  mac-studio: /Users/eric/Sync/live",
      "  qnap-ts453d: /share/Sync/live",
    ].join("\n"),
  );
  for (const [name, os, role] of [
    ["mac-studio", "macos", "mesh-node"],
    ["qnap-ts453d", "qnap", "cloud-edge"],
  ] as const) {
    writeFileSync(
      join(configDir, "hosts", `${name}.yaml`),
      [
        `name: ${name}`,
        `hostname: ${name}.local`,
        `os: ${os}`,
        `role: ${role}`,
        "syncthing:",
        "  install_method: docker",
        "  api_url: http://127.0.0.1:1",
        `  api_key_ref: secrets/x.enc.yaml#${name}`,
        `  device_id_ref: secrets/y.enc.yaml#${name}`,
      ].join("\n"),
    );
  }
  writeFileSync(
    join(configDir, "hosts", "gdrive.yaml"),
    ["name: gdrive", "engine: rclone", "remote: gdrive"].join("\n"),
  );
  cfg = loadConfig({ SC_CONFIG_DIR: configDir, SC_API_TOKEN: TOKEN, PORT: "0", SC_DB_PATH: ":memory:" });
});

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  db = openDb(":memory:");
  bus = new EventBus();
  log = new Log(db, bus);
  qnap = new FakeDaemon();
  mac = new FakeDaemon();
  const clients = new Map<string, SyncthingClient>();
  clients.set("qnap-ts453d", qnap as unknown as SyncthingClient);
  clients.set("mac-studio", mac as unknown as SyncthingClient);
  const registry = new HostRegistry({ cfg, clients });
  clock = new Date("2026-08-25T09:30:00");
  engine = new SyncWindowEngine({ cfg, db, bus, registry, log, now: () => clock });
  bisyncCalls = [];
  bisyncFails = null;
  let nextRun = 1;
  syncNow = new SyncNow({
    cfg,
    db,
    bus,
    log,
    registry,
    engine,
    bisync: async (folder, opts): Promise<BisyncStarted> => {
      bisyncCalls.push({ folder, opts });
      if (bisyncFails) {
        const err = bisyncFails;
        bisyncFails = null;
        throw err;
      }
      const id = nextRun++;
      // A real run row, so the job has a leg to settle on; the tracker is
      // not in this test, so tests finish it by hand (see `endRun`).
      const row = startRun(db, {
        folder,
        member: opts.member ?? "gdrive",
        jobid: 100 + id,
        actor: opts.actor,
        source: opts.source,
        jobId: opts.jobId ?? null,
      });
      return {
        folder,
        member: opts.member ?? "gdrive",
        path1: "/share/Sync/" + folder,
        path2: "gdrive:sync/" + folder,
        filtersFile: "/config/filters/base-binaries.rclone",
        out: { jobid: 100 + id },
        run: toView(row),
      };
    },
  });
});

const tick = () => engine.tick();
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};
/** Drive the open window to a clean close: past the minimum, two settled polls. */
const settle = async () => {
  advance(31_000);
  await tick();
  await tick();
};
const who = { actor: "tester", source: "api" as const };
const lines = (): LogLine[] => log.list({ limit: 100 });
/** What the run tracker does when rclone reports the job over. */
const endRun = (id: number, state: "done" | "failed" | "stopped" = "done", bytes = 0) => {
  db.run("UPDATE runs SET bytes = ?, transfers = ?, checks = 3 WHERE id = ?", [bytes, bytes > 0 ? 1 : 0, id]);
  const row = finishRun(db, id, state, state === "failed" ? "rclone said no" : null)!;
  settleJob(db, row.job_id!);
  return row;
};
const job = (id: number) => toJobView(db, getJob(db, id)!);

describe("SyncNow", () => {
  it("opens the window, queues the cloud leg, and runs the bisync once the window closes", async () => {
    const out = await syncNow.run("cloudy", who);
    expect(out.windows).toHaveLength(1);
    expect(out.windows[0]!.host).toBe("qnap-ts453d");
    expect(out.windows[0]!.state).toBe("running");
    expect(out.failed).toEqual([]);
    expect(out.cloud).toEqual({ status: "queued", members: ["gdrive"], after: [out.windows[0]!.id] });
    expect(qnap.calls).toContain("resumeFolder:cloudy");
    // Nothing goes to Drive while the NAS is still catching up from the Mac.
    expect(bisyncCalls).toHaveLength(0);
    expect(syncNow.queuedAfter("cloudy")).toEqual([out.windows[0]!.id]);

    await settle();
    expect(getWindow(db, out.windows[0]!.id)!.state).toBe("done");
    expect(bisyncCalls).toHaveLength(1);
    expect(bisyncCalls[0]).toEqual({
      folder: "cloudy",
      opts: { member: "gdrive", async: true, actor: "tester", source: "api", jobId: out.job.id },
    });
    expect(syncNow.queuedAfter("cloudy")).toBeNull();

    const story = lines().map((l) => l.message);
    expect(story.some((m) => m.startsWith("sync now requested by tester"))).toBe(true);
    expect(story.some((m) => m.startsWith("cloud leg queued: bisync → gdrive"))).toBe(true);
  });

  it("skips the cloud leg when the window is closed by hand", async () => {
    const out = await syncNow.run("cloudy", who);
    await engine.stopWindow(out.windows[0]!.id);
    await tick();
    expect(bisyncCalls).toHaveLength(0);
    expect(syncNow.queuedAfter("cloudy")).toBeNull();
    const warn = lines().find((l) => l.level === "warn" && l.source === "sync");
    expect(warn?.message).toContain("closed by hand");
  });

  it("still runs the cloud leg after a window that closed at its cap", async () => {
    const out = await syncNow.run("cloudy", who);
    qnap.state = "syncing";
    qnap.needBytes = 999;
    advance(46 * 60_000);
    await tick();
    expect(getWindow(db, out.windows[0]!.id)!.state).toBe("timeout");
    // A partial catch-up is still worth pushing to Drive — that is what the
    // nightly cron does every night regardless.
    expect(bisyncCalls).toHaveLength(1);
  });

  it("goes straight to the bisync when no member is held", async () => {
    const out = await syncNow.run("cloud-only", who);
    expect(out.windows).toEqual([]);
    expect(out.cloud?.status).toBe("started");
    if (out.cloud?.status !== "started") throw new Error("unreachable");
    expect(out.cloud.runs).toHaveLength(1);
    expect(out.cloud.runs[0]!.member).toBe("gdrive");
    expect(out.cloud.errors).toEqual([]);
    expect(bisyncCalls).toHaveLength(1);
    expect(qnap.calls.filter((c) => c.startsWith("resumeFolder"))).toEqual([]);
  });

  it("cloud: false opens the window and stops there", async () => {
    const out = await syncNow.run("cloudy", { ...who, cloud: false });
    expect(out.windows).toHaveLength(1);
    expect(out.cloud).toBeNull();
    await settle();
    expect(bisyncCalls).toHaveLength(0);
  });

  it("refuses a folder with nothing to sync now", async () => {
    await expect(syncNow.run("live", who)).rejects.toThrow(/nothing to sync now/);
    await expect(syncNow.run("live", who)).rejects.toBeInstanceOf(SyncNowError);
    await expect(syncNow.run("nope", who)).rejects.toMatchObject({ status: 404 });
    // The old contract for windows-only: a realtime-only mesh is a 400 too.
    await expect(syncNow.run("live", { ...who, cloud: false })).rejects.toMatchObject({ status: 400 });
  });

  it("adopts a window that is already open and queues a single cloud leg", async () => {
    const first = await syncNow.run("cloudy", who);
    const second = await syncNow.run("cloudy", who);
    expect(second.windows.map((w) => w.id)).toEqual(first.windows.map((w) => w.id));
    expect(second.failed).toEqual([]);
    expect(second.cloud).toEqual({ status: "queued", members: ["gdrive"], after: first.cloud?.status === "queued" ? first.cloud.after : [] });
    await settle();
    // One window, one bisync — not one per press.
    expect(bisyncCalls).toHaveLength(1);
  });

  it("records a ledger row when the cloud leg cannot start", async () => {
    bisyncFails = new BisyncStartError("compiled filter.rclone missing at /nope", 409, { error: "missing" });
    const out = await syncNow.run("cloud-only", who);
    if (out.cloud?.status !== "started") throw new Error("unreachable");
    expect(out.cloud.runs).toEqual([]);
    expect(out.cloud.errors).toEqual([{ member: "gdrive", error: "compiled filter.rclone missing at /nope" }]);
    const history = db
      .query("SELECT result, note, payload_hash FROM apply_history")
      .all() as Array<{ result: string; note: string; payload_hash: string }>;
    expect(history).toHaveLength(1);
    expect(history[0]!.result).toBe("error");
    expect(history[0]!.payload_hash).toBe("bisync");
    expect(history[0]!.note).toContain("bisync → gdrive did not start");
    expect(lines().some((l) => l.level === "error" && l.message.includes("did not start"))).toBe(true);
  });

  it("a queued cloud leg that cannot start lands in the ledger too", async () => {
    const out = await syncNow.run("cloudy", who);
    bisyncFails = new BisyncStartError("rclone is not configured (set SC_RCLONE_URL)", 503, { error: "x" });
    await settle();
    expect(getWindow(db, out.windows[0]!.id)!.state).toBe("done");
    const history = db.query("SELECT result, note FROM apply_history ORDER BY id").all() as Array<{
      result: string;
      note: string;
    }>;
    // The window's own row, then the cloud leg's failure.
    expect(history.map((h) => h.result)).toEqual(["ok", "error"]);
    expect(history[1]!.note).toContain("rclone is not configured");
  });

  it("with ?host= on a realtime member, reports the failure and still runs the cloud leg", async () => {
    const out = await syncNow.run("cloudy", { ...who, host: "mac-studio" });
    expect(out.windows).toEqual([]);
    expect(out.failed).toEqual([{ host: "mac-studio", error: expect.stringContaining("realtime") }]);
    expect(out.cloud?.status).toBe("started");
    expect(bisyncCalls).toHaveLength(1);
  });

  it("with ?host= on a realtime member and no cloud leg, fails the way the old route did", async () => {
    await expect(syncNow.run("cloudy", { ...who, host: "mac-studio", cloud: false })).rejects.toMatchObject({
      status: 400,
      code: "REALTIME_MEMBER",
    });
  });

  it("runs the cloud leg when the window could not even open", async () => {
    qnap.failResume = new Error("connection refused");
    const out = await syncNow.run("cloudy", who);
    // open() returns the failed row rather than throwing.
    expect(out.windows[0]!.state).toBe("failed");
    // No running window to wait for, so the cloud leg goes now: the NAS may
    // be behind the Mac, but Drive being behind the NAS is a separate leg.
    expect(out.cloud?.status).toBe("started");
    expect(bisyncCalls).toHaveLength(1);
  });
});

describe("jobs — every leg under one id", () => {
  it("a Sync now chain is one job: pending, then running, then done", async () => {
    const out = await syncNow.run("cloudy", who);
    expect(out.job.kind).toBe("sync");
    expect(out.job.via).toBe("manual");
    expect(out.job.state).toBe("running");
    expect(out.job.cloudPending).toBe(true);
    expect(out.job.hosts).toEqual(["qnap-ts453d"]);
    expect(out.job.cloud).toEqual(["gdrive"]);
    expect(out.job.after).toEqual([out.windows[0]!.id]);
    expect(out.windows[0]!.job_id).toBe(out.job.id);
    expect(out.job.windows.map((w) => w.id)).toEqual([out.windows[0]!.id]);
    expect(out.job.totals.legs).toBe(1);

    await settle();
    // Window done, bisync started under the same job: still running.
    const mid = job(out.job.id);
    expect(mid.state).toBe("running");
    expect(mid.cloudPending).toBe(false);
    expect(mid.runs).toHaveLength(1);
    expect(mid.runs[0]!.job_id).toBe(out.job.id);
    expect(mid.totals.legs).toBe(2);
    expect(mid.totals.legsDone).toBe(1);
    expect(mid.totals.legsRunning).toBe(1);

    endRun(mid.runs[0]!.id, "done", 4096);
    const done = job(out.job.id);
    expect(done.state).toBe("done");
    expect(done.finished_at).not.toBeNull();
    expect(done.totals.bytes).toBe(4096);
    expect(done.totals.transfers).toBe(1);
    expect(done.totals.checks).toBe(3);
    expect(done.totals.legsDone).toBe(2);
    expect(done.totals.legsFailed).toBe(0);
  });

  it("closing the window by hand leaves the job stopped, with the reason", async () => {
    const out = await syncNow.run("cloudy", who);
    await engine.stopWindow(out.windows[0]!.id);
    await tick();
    const j = job(out.job.id);
    expect(j.state).toBe("stopped");
    expect(j.cloudPending).toBe(false);
    expect(j.note).toContain("closed by hand");
    expect(j.runs).toEqual([]);
  });

  it("a window at its cap and a bisync that ran is a partial job", async () => {
    const out = await syncNow.run("cloudy", who);
    qnap.state = "syncing";
    qnap.needBytes = 999;
    advance(46 * 60_000);
    await tick();
    const runs = listRunsForJobs(db, [out.job.id]);
    expect(runs).toHaveLength(1);
    endRun(runs[0]!.id);
    expect(job(out.job.id).state).toBe("partial");
    expect(job(out.job.id).totals.legsFailed).toBe(1);
  });

  it("no held member: a bisync job; cloud: false: a window job", async () => {
    const cloud = await syncNow.run("cloud-only", who);
    expect(cloud.job.kind).toBe("bisync");
    expect(cloud.job.windows).toEqual([]);
    expect(cloud.job.runs).toHaveLength(1);
    expect(cloud.job.state).toBe("running");
    endRun(cloud.job.runs[0]!.id);
    expect(job(cloud.job.id).state).toBe("done");

    const win = await syncNow.run("cloudy", { ...who, cloud: false });
    expect(win.job.kind).toBe("window");
    expect(win.job.cloudPending).toBe(false);
    await settle();
    expect(job(win.job.id).state).toBe("done");
    expect(bisyncCalls).toHaveLength(1);
  });

  it("a second press rides the first press's job", async () => {
    const first = await syncNow.run("cloudy", who);
    const second = await syncNow.run("cloudy", who);
    expect(second.job.id).toBe(first.job.id);
    expect(db.query("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 1 });
  });

  it("a bisync that cannot start is a failed leg with the reason on the job", async () => {
    bisyncFails = new BisyncStartError("compiled filter.rclone missing at /nope", 409, { error: "missing" });
    const out = await syncNow.run("cloud-only", who);
    expect(out.job.state).toBe("failed");
    expect(out.job.legsFailed).toBe(1);
    expect(out.job.note).toContain("bisync → gdrive did not start");
    expect(out.job.totals.legs).toBe(1);
    expect(out.job.totals.legsFailed).toBe(1);

    // Queued behind a window that then closes clean: partial, not failed.
    const chain = await syncNow.run("cloudy", who);
    bisyncFails = new BisyncStartError("rclone is not configured (set SC_RCLONE_URL)", 503, { error: "x" });
    await settle();
    const j = job(chain.job.id);
    expect(j.state).toBe("partial");
    expect(j.note).toContain("rclone is not configured");
  });

  it("a window that could not open counts as a failed leg", async () => {
    await expect(syncNow.run("cloudy", { ...who, host: "mac-studio", cloud: false })).rejects.toBeInstanceOf(SyncNowError);
    const rows = db.query("SELECT id, state, legs_failed, note FROM jobs").all() as Array<{
      id: number;
      state: string;
      legs_failed: number;
      note: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("failed");
    expect(rows[0]!.legs_failed).toBe(1);
    expect(rows[0]!.note).toContain("realtime");
  });

  it("a scheduled window is a job of its own, via the schedule", async () => {
    advance(31 * 60_000); // 09:30 → 10:01, past cloudy's hourly window
    await engine.checkSchedules();
    const rows = db.query("SELECT * FROM jobs").all() as Array<{ kind: string; via: string; source: string; state: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "window", via: "schedule", source: "schedule", state: "running" });
    await settle();
    expect((db.query("SELECT state FROM jobs").get() as { state: string }).state).toBe("done");
  });

  it("settles from what the legs say", () => {
    const mk = (legs: Array<"done" | "failed" | "timeout" | "stopped">, legsFailed = 0) => {
      const j = startJob(db, { folder: "cloudy", kind: "sync", via: "manual", hosts: [], cloud: [], actor: "t", source: "api" });
      for (const state of legs) {
        const w = startWindow(db, { folder: "cloudy", host: "qnap-ts453d", via: "manual", maxMinutes: 1, actor: "t", source: "api", jobId: j.id });
        finishWindow(db, w.id, state, null);
      }
      if (legsFailed > 0) db.run("UPDATE jobs SET legs_failed = ? WHERE id = ?", [legsFailed, j.id]);
      return settleJob(db, j.id)!.job.state;
    };
    expect(mk(["done", "done"])).toBe("done");
    expect(mk(["done", "stopped"])).toBe("stopped");
    expect(mk(["stopped"])).toBe("stopped");
    expect(mk(["timeout"])).toBe("failed");
    expect(mk(["failed", "timeout"])).toBe("failed");
    expect(mk(["timeout", "done"])).toBe("partial");
    expect(mk(["stopped", "failed"])).toBe("partial");
    expect(mk(["done"], 1)).toBe("partial");
    expect(mk([], 1)).toBe("failed");
    expect(mk([])).toBe("failed");
  });

  it("does not settle while a leg runs or the cloud leg is pending", async () => {
    const out = await syncNow.run("cloudy", who);
    expect(settleJob(db, out.job.id)!.changed).toBe(false);
    await settle();
    // Window done, run running.
    expect(settleJob(db, out.job.id)!.changed).toBe(false);
    expect(getJob(db, out.job.id)!.state).toBe("running");
  });

  it("settles the job that only rode a window it did not open", async () => {
    // Press one opens the window and owns it; press two rides it. With no
    // cloud leg, the rider's only leg is a row belonging to someone else.
    const first = await syncNow.run("cloudy", { ...who, cloud: false });
    const second = await syncNow.run("cloudy", { ...who, cloud: false });
    const w = first.windows[0]!.id;
    expect(second.windows[0]!.id).toBe(w);
    expect(job(second.job.id).after).toEqual([w]);

    await settle();
    expect(getWindow(db, w)!.state).toBe("done");
    // The window's own job and the one that adopted it both close.
    expect(getJob(db, first.job.id)!.state).toBe("done");
    expect(getJob(db, second.job.id)!.state).toBe("done");
    expect(getJob(db, second.job.id)!.finished_at).not.toBeNull();
  });

  it("keeps the job open while the rest of its windows are still opening", async () => {
    // The first host cannot be resumed, which closes its window from inside
    // open() — while the loop is still about to open the second host.
    mac.failResume = new Error("connection refused");
    const out = await syncNow.run("two-held", { ...who, cloud: false });
    expect(out.windows.map((w) => w.state)).toEqual(["failed", "running"]);
    // Not closed on the strength of the failed leg alone.
    expect(getJob(db, out.job.id)!.state).toBe("running");
    expect(out.job.state).toBe("running");

    await settle();
    expect(getWindow(db, out.windows[1]!.id)!.state).toBe("done");
    const settled = getJob(db, out.job.id)!;
    expect(settled.state).toBe("partial");
    // The job ends with its last leg, not before its second one started.
    expect(settled.finished_at).toBe(getWindow(db, out.windows[1]!.id)!.finished_at);
  });

  it("two presses that overlap the resume round trip still run one bisync", async () => {
    // Press one inserts the window row, then waits inside resumeFolder; press
    // two arrives in that gap, sees the row, and adopts it.
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realResume = qnap.resumeFolder.bind(qnap);
    qnap.resumeFolder = async (id: string) => {
      qnap.resumeFolder = realResume;
      await gate;
      await realResume(id);
    };
    const p1 = syncNow.run("cloudy", who);
    const p2 = syncNow.run("cloudy", who);
    release();
    const [first, second] = await Promise.all([p1, p2]);

    const w = first.windows[0]!.id;
    expect(second.windows[0]!.id).toBe(w);
    expect(syncNow.queuedAfter("cloudy")).toEqual([w]);

    await settle();
    // One window closing must not start the same bisync under two jobs.
    expect(bisyncCalls).toHaveLength(1);
    expect(listRunsForJobs(db, [first.job.id, second.job.id])).toHaveLength(1);
    expect(getJob(db, first.job.id)!.state).not.toBe("running");
  });

  it("a stopped job does not run its cloud leg when the window it was riding closes", async () => {
    const owner = await syncNow.run("cloudy", { ...who, cloud: false });
    const rider = await syncNow.run("cloudy", who);
    expect(rider.job.after).toEqual([owner.windows[0]!.id]);
    // What POST /jobs/:id/stop does to a job whose only leg is adopted.
    stopJob(db, bus, rider.job.id, "stopped from the dashboard while riding window #1");
    expect(getJob(db, rider.job.id)!.state).toBe("stopped");

    await settle();
    expect(getWindow(db, owner.windows[0]!.id)!.state).toBe("done");
    // The operator stopped the press; its bisync must not run behind them.
    expect(bisyncCalls).toEqual([]);
    expect(getJob(db, rider.job.id)!.state).toBe("stopped");
  });

  it("a chain already queued waits for the windows a later press opens", async () => {
    // Press one covers the Mac only, so its chain waits on that one window.
    const first = await syncNow.run("two-held-cloud", { ...who, host: "mac-studio" });
    expect(syncNow.queuedAfter("two-held-cloud")).toEqual([first.windows[0]!.id]);
    // Press two adopts it and opens the NAS window; one chain, two windows.
    const second = await syncNow.run("two-held-cloud", who);
    const nas = second.windows.find((w) => w.host === "qnap-ts453d")!;
    expect(syncNow.queuedAfter("two-held-cloud")).toEqual([first.windows[0]!.id, nas.id]);
    expect(second.cloud).toEqual({
      status: "queued",
      members: ["gdrive"],
      after: [first.windows[0]!.id, nas.id],
    });

    // Close the Mac window alone: the NAS has not caught up, so Drive waits.
    qnap.state = "syncing";
    qnap.needBytes = 4096;
    qnap.needFiles = 2;
    await settle();
    expect(getWindow(db, first.windows[0]!.id)!.state).toBe("done");
    expect(getWindow(db, nas.id)!.state).toBe("running");
    expect(bisyncCalls).toEqual([]);

    // Now the NAS catches up too, and the one bisync runs.
    qnap.state = "idle";
    qnap.needBytes = 0;
    qnap.needFiles = 0;
    await settle();
    expect(getWindow(db, nas.id)!.state).toBe("done");
    expect(bisyncCalls).toHaveLength(1);
  });

  it("a window stopped while its resume is still in flight is only closed once", async () => {
    // open() inserts the row, then awaits resumeFolder. A stop in that gap
    // closes the window; the resume then fails and tries to close it again.
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    qnap.resumeFolder = async (id: string) => {
      qnap.calls.push(`resumeFolder:${id}`);
      await gate;
      throw new Error("connection refused");
    };
    const opening = syncNow.run("cloudy", { ...who, cloud: false });
    const w = activeWindowFor(db, "cloudy", "qnap-ts453d")!;
    await engine.stopWindow(w.id);
    release();
    await opening;

    expect(getWindow(db, w.id)!.state).toBe("stopped");
    // One close, so one ledger row and no "failed" line about a stopped window.
    const ledger = db.query("SELECT result, note FROM apply_history").all() as Array<{ result: string; note: string }>;
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.note).toContain("stopped");
    // And no second, contradicting line calling the stopped window failed.
    expect(lines().filter((l) => l.message.includes("could not resume"))).toEqual([]);
    expect(lines().filter((l) => l.message.includes(`window #${w.id} on qnap-ts453d closed by hand`))).toHaveLength(1);
  });

  it("a restart closes a job that was waiting on its cloud leg", async () => {
    const out = await syncNow.run("cloudy", who);
    // What boot does to the legs, then to the jobs.
    db.run("UPDATE sync_windows SET state = 'failed', finished_at = ? WHERE state = 'running'", [clock.toISOString()]);
    expect(abandonStaleJobs(db)).toBe(1);
    const j = job(out.job.id);
    expect(j.state).toBe("failed");
    expect(j.cloudPending).toBe(false);
    expect(j.note).toContain("SyncCenter restarted");
    expect(j.legsFailed).toBe(1);
    expect(getRun(db, 1)).toBeNull();
  });
});
