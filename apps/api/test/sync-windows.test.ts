import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SyncthingClient } from "@synccenter/adapters";
import { loadConfig, type ApiConfig } from "../src/config.ts";
import { openDb, type Db } from "../src/db.ts";
import { EventBus, type ScEvent } from "../src/lib/bus.ts";
import { HostRegistry } from "../src/registry.ts";
import { SyncWindowEngine } from "../src/lib/sync-windows.ts";
import { activeWindowFor, getWindow, listWindows } from "../src/lib/windows-service.ts";
import { firesBetween } from "../src/lib/cron-times.ts";
import { FakeDaemon } from "./helpers/fake-daemon.ts";

const TOKEN = "test-token-of-sufficient-length-1234567890";

let tmpRoot: string;
let cfg: ApiConfig;
let db: Db;
let bus: EventBus;
let events: ScEvent[];
let qnap: FakeDaemon;
let mac: FakeDaemon;
let engine: SyncWindowEngine;
let clock: Date;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "synccenter-windows-"));
  const configDir = join(tmpRoot, "config");
  for (const sub of ["rules", "folders", "hosts", "imports", "schedules", "compiled"]) {
    mkdirSync(join(configDir, sub), { recursive: true });
  }
  writeFileSync(
    join(configDir, "rules", "base-binaries.yaml"),
    "name: base-binaries\nversion: 1\nexcludes:\n  - .DS_Store\n",
  );
  writeFileSync(
    join(configDir, "folders", "held.yaml"),
    [
      "name: held",
      "ruleset: base-binaries",
      "type: send-receive",
      "paths:",
      "  mac-studio: /Users/eric/Sync/held",
      "  qnap-ts453d: /share/Sync/held",
      "overrides:",
      "  qnap-ts453d:",
      "    sync:",
      "      mode: scheduled",
      '      schedule: "0 * * * *"',
      "      max_window_minutes: 45",
    ].join("\n"),
  );
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
  cfg = loadConfig({ SC_CONFIG_DIR: configDir, SC_API_TOKEN: TOKEN, PORT: "0", SC_DB_PATH: ":memory:" });
});

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  db = openDb(":memory:");
  bus = new EventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
  qnap = new FakeDaemon();
  mac = new FakeDaemon();
  const clients = new Map<string, SyncthingClient>();
  clients.set("qnap-ts453d", qnap as unknown as SyncthingClient);
  clients.set("mac-studio", mac as unknown as SyncthingClient);
  const registry = new HostRegistry({ cfg, clients });
  clock = new Date("2026-08-15T09:30:00");
  engine = new SyncWindowEngine({ cfg, db, bus, registry, now: () => clock });
});

const tick = () => engine.tick();
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

describe("SyncWindowEngine", () => {
  it("lists only scheduled/manual members as sync jobs", () => {
    const jobs = engine.syncJobs();
    expect(jobs).toEqual([
      { folder: "held", host: "qnap-ts453d", mode: "scheduled", cron: "0 * * * *", maxWindowMinutes: 45 },
    ]);
  });

  it("open resumes the folder, then a caught-up settle closes it and pauses again", async () => {
    const row = await engine.open("held", "qnap-ts453d", "manual", "tester", "api");
    expect(row.state).toBe("running");
    expect(qnap.calls).toContain("resumeFolder:held");
    expect(qnap.paused).toBe(false);

    // Immediately idle — but the minimum window hasn't elapsed, so it stays open.
    await tick();
    expect(getWindow(db, row.id)!.state).toBe("running");

    // Past the minimum, caught up locally and at the peer: two settle ticks close it.
    advance(31_000);
    await tick();
    expect(getWindow(db, row.id)!.state).toBe("running");
    await tick();
    const done = getWindow(db, row.id)!;
    expect(done.state).toBe("done");
    expect(qnap.calls.filter((c) => c === "pauseFolder:held").length).toBe(1);

    // A window landed in the ledger and on the bus.
    const history = db.query("SELECT * FROM apply_history").all() as Array<{ note: string; result: string }>;
    expect(history.length).toBe(1);
    expect(history[0]!.result).toBe("ok");
    expect(events.some((e) => e.type === "window")).toBe(true);
  });

  it("keeps the window open while syncing and reports progress", async () => {
    const row = await engine.open("held", "qnap-ts453d", "manual", "tester", "api");
    qnap.state = "syncing";
    qnap.needBytes = 400;
    qnap.needFiles = 3;
    qnap.inSyncBytes = 600;
    advance(31_000);
    await tick();
    const w = getWindow(db, row.id)!;
    expect(w.state).toBe("running");
    expect(w.sync_state).toBe("syncing");
    expect(w.need_bytes).toBe(400);
    expect(w.in_sync_bytes).toBe(600);
  });

  it("waits for connected peers to finish pulling before closing", async () => {
    const row = await engine.open("held", "qnap-ts453d", "manual", "tester", "api");
    qnap.peerCompletion = 42;
    advance(31_000);
    await tick();
    await tick();
    expect(getWindow(db, row.id)!.state).toBe("running");

    qnap.peerCompletion = 100;
    await tick();
    await tick();
    expect(getWindow(db, row.id)!.state).toBe("done");
  });

  it("times out a window at its cap and still pauses the folder", async () => {
    const row = await engine.open("held", "qnap-ts453d", "manual", "tester", "api");
    qnap.state = "syncing";
    qnap.needBytes = 999;
    advance(46 * 60_000); // past max_window_minutes: 45
    await tick();
    const w = getWindow(db, row.id)!;
    expect(w.state).toBe("timeout");
    expect(qnap.calls).toContain("pauseFolder:held");
  });

  it("declares a window lost after repeated failed polls", async () => {
    const row = await engine.open("held", "qnap-ts453d", "manual", "tester", "api");
    qnap.failStatus = new Error("connection refused");
    advance(31_000);
    for (let i = 0; i < 5; i++) await tick();
    expect(getWindow(db, row.id)!.state).toBe("failed");
  });

  it("refuses realtime members, unknown pairs, and double-opens", async () => {
    await expect(engine.open("held", "mac-studio", "manual", "t", "api")).rejects.toThrow(/realtime/);
    await expect(engine.open("held", "nope", "manual", "t", "api")).rejects.toThrow(/not a member/);
    await expect(engine.open("nope", "qnap-ts453d", "manual", "t", "api")).rejects.toThrow(/not found/);
    await engine.open("held", "qnap-ts453d", "manual", "t", "api");
    await expect(engine.open("held", "qnap-ts453d", "manual", "t", "api")).rejects.toThrow(/already open/);
  });

  it("stopWindow closes early and pauses", async () => {
    const row = await engine.open("held", "qnap-ts453d", "manual", "tester", "api");
    const out = await engine.stopWindow(row.id);
    expect(out!.state).toBe("stopped");
    expect(qnap.calls).toContain("pauseFolder:held");
  });

  it("checkSchedules opens a window when the cron fires, once", async () => {
    // Construction swept up to 09:30; cross the 10:00 boundary.
    advance(31 * 60_000);
    await engine.checkSchedules();
    const w = activeWindowFor(db, "held", "qnap-ts453d");
    expect(w).not.toBeNull();
    expect(w!.via).toBe("schedule");

    // The same fire is not re-processed on the next sweep.
    await engine.checkSchedules();
    expect(listWindows(db).length).toBe(1);
  });

  it("reconcile pauses a held member left unpaused, and leaves realtime folders alone", async () => {
    qnap.paused = false;
    mac.paused = false;
    await engine.reconcile();
    expect(qnap.calls).toContain("pauseFolder:held");
    // The realtime folder was never touched on either host.
    expect(qnap.calls).not.toContain("pauseFolder:live");
    expect(mac.calls.filter((c) => c.startsWith("pauseFolder"))).toEqual([]);
  });

  it("reconcile leaves a pair with an open window alone", async () => {
    await engine.open("held", "qnap-ts453d", "manual", "tester", "api");
    qnap.calls = [];
    await engine.reconcile();
    expect(qnap.calls).not.toContain("pauseFolder:held");
  });
});

describe("firesBetween", () => {
  it("finds every fire in the gap, and nothing outside it", () => {
    const fires = firesBetween(
      "*/15 * * * *",
      new Date("2026-08-15T09:29:00"),
      new Date("2026-08-15T10:01:00"),
    );
    expect(fires.map((d) => d.toISOString())).toEqual([
      new Date("2026-08-15T09:30:00").toISOString(),
      new Date("2026-08-15T09:45:00").toISOString(),
      new Date("2026-08-15T10:00:00").toISOString(),
    ]);
  });

  it("returns [] for an unparsable expression", () => {
    expect(firesBetween("not a cron", new Date(), new Date(Date.now() + 60_000))).toEqual([]);
  });
});

describe("GET /schedule without secrets", () => {
  it("plans the bisync legs and the windows with no sops in sight", async () => {
    // A folder with an rclone member used to force the jobs loop through the
    // secrets resolver, which cannot succeed in this fixture — no sops, no enc
    // files — and the deployed container was in exactly that position. The
    // schedule needs nothing secret: it must come out of the manifests alone.
    writeFileSync(
      join(cfg.hostsDir, "gdrive.yaml"),
      ["name: gdrive", "engine: rclone", "remote: gdrive"].join("\n"),
    );
    writeFileSync(
      join(cfg.foldersDir, "cloudy.yaml"),
      [
        "name: cloudy",
        "ruleset: base-binaries",
        "type: send-receive",
        'bisync: { schedule: "0 4 * * *" }',
        "paths:",
        "  qnap-ts453d: /share/Sync/cloudy",
        "  gdrive: sync/cloudy",
      ].join("\n"),
    );
    try {
      const { buildApp } = await import("../src/app.ts");
      const clients = new Map<string, SyncthingClient>();
      clients.set("qnap-ts453d", qnap as unknown as SyncthingClient);
      clients.set("mac-studio", mac as unknown as SyncthingClient);
      const registry = new HostRegistry({ cfg, clients });
      const built = buildApp({ cfg, registry, rclone: null });
      const server = await new Promise<import("node:http").Server>((resolve) => {
        const s = built.app.listen(0, () => resolve(s));
      });
      const port = (server.address() as import("node:net").AddressInfo).port;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/schedule`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { jobs: unknown[]; windows: unknown[]; jobsError?: string };
        expect(body.windows).toEqual([
          { folder: "held", host: "qnap-ts453d", cron: "0 * * * *", maxWindowMinutes: 45 },
        ]);
        expect(body.jobs).toEqual([
          expect.objectContaining({
            folder: "cloudy",
            anchor: "qnap-ts453d",
            member: "gdrive",
            cron: "0 4 * * *",
            command: expect.stringContaining("bisync /share/Sync/cloudy gdrive:sync/cloudy"),
          }),
        ]);
        expect(body.jobsError).toBeUndefined();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      rmSync(join(cfg.hostsDir, "gdrive.yaml"), { force: true });
      rmSync(join(cfg.foldersDir, "cloudy.yaml"), { force: true });
    }
  });
});
