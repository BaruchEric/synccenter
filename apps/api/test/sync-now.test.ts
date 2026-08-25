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
import { SyncNow, SyncNowError } from "../src/lib/sync-now.ts";
import { SyncWindowEngine } from "../src/lib/sync-windows.ts";
import { getWindow } from "../src/lib/windows-service.ts";
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
      return {
        folder,
        member: opts.member ?? "gdrive",
        path1: "/share/Sync/" + folder,
        path2: "gdrive:sync/" + folder,
        filtersFile: "/config/filters/base-binaries.rclone",
        out: { jobid: 100 + id },
        run: {
          id,
          folder,
          member: opts.member ?? "gdrive",
          jobid: 100 + id,
          stats_group: null,
          started_at: clock.toISOString(),
          finished_at: null,
          state: "running",
          bytes: 0,
          total_bytes: 0,
          transfers: 0,
          checks: 0,
          listed: 0,
          errors: 0,
          speed: 0,
          eta: null,
          current: null,
          error: null,
          actor: opts.actor,
          source: opts.source,
          dry_run: 0,
          resync: 0,
          misses: 0,
          phase: "starting",
          fraction: null,
        },
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
      opts: { member: "gdrive", async: true, actor: "tester", source: "api" },
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
