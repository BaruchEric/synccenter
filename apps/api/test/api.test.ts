import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RcloneClient, RcloneError, SyncthingClient, SyncthingError } from "@synccenter/adapters";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { HostRegistry } from "../src/registry.ts";

const TOKEN = "test-token-of-sufficient-length-1234567890";

interface FakeCall {
  method: string;
  args: unknown[];
}

class FakeSyncthing {
  public readonly calls: FakeCall[] = [];
  public failNext: Error | null = null;

  async getVersion() {
    this.calls.push({ method: "getVersion", args: [] });
    if (this.shouldFail()) throw this.popFail();
    return { arch: "amd64", longVersion: "v1.30.0", os: "linux", version: "v1.30.0" };
  }
  async getStatus() {
    this.calls.push({ method: "getStatus", args: [] });
    if (this.shouldFail()) throw this.popFail();
    return { myID: "FAKE-DEVICE-ID", uptime: 42, startTime: "2026-05-14T00:00:00Z", alloc: 1, goroutines: 1 };
  }
  async listFolders() {
    this.calls.push({ method: "listFolders", args: [] });
    if (this.shouldFail()) throw this.popFail();
    return [];
  }
  async getFolderStatus(id: string) {
    this.calls.push({ method: "getFolderStatus", args: [id] });
    if (this.shouldFail()) throw this.popFail();
    return {
      state: "idle" as const,
      globalBytes: 0,
      globalFiles: 0,
      localBytes: 0,
      localFiles: 0,
      needBytes: 0,
      needFiles: 0,
      errors: 0,
      pullErrors: 0,
      sequence: 1,
      stateChanged: "2026-05-14T00:00:00Z",
    };
  }
  async setIgnores(folder: string, lines: string[]) {
    this.calls.push({ method: "setIgnores", args: [folder, lines] });
    if (this.shouldFail()) throw this.popFail();
    return { ignore: lines, expanded: lines };
  }
  async scan(folder: string, sub?: string) {
    this.calls.push({ method: "scan", args: [folder, sub] });
    if (this.shouldFail()) throw this.popFail();
  }
  async pauseFolder(id: string) {
    this.calls.push({ method: "pauseFolder", args: [id] });
    if (this.shouldFail()) throw this.popFail();
  }
  async resumeFolder(id: string) {
    this.calls.push({ method: "resumeFolder", args: [id] });
    if (this.shouldFail()) throw this.popFail();
  }

  private shouldFail(): boolean {
    return this.failNext !== null;
  }
  private popFail(): Error {
    const e = this.failNext!;
    this.failNext = null;
    return e;
  }
}

class FakeRclone {
  public readonly calls: FakeCall[] = [];
  public failNext: Error | null = null;
  public nextBisyncResult: Record<string, unknown> = { jobid: 7 };

  async getVersion() {
    this.calls.push({ method: "getVersion", args: [] });
    if (this.shouldFail()) throw this.popFail();
    return { version: "v1.69.0", goVersion: "go1.22", os: "linux", arch: "amd64" };
  }
  async listRemotes() {
    this.calls.push({ method: "listRemotes", args: [] });
    if (this.shouldFail()) throw this.popFail();
    return { remotes: ["gdrive", "b2"] };
  }
  async jobStatus(jobid: number) {
    this.calls.push({ method: "jobStatus", args: [jobid] });
    if (this.shouldFail()) throw this.popFail();
    return {
      id: jobid,
      startTime: "2026-05-14T00:00:00Z",
      duration: 1,
      finished: true,
      success: true,
    };
  }
  async getStats(group?: string) {
    this.calls.push({ method: "getStats", args: [group] });
    if (this.shouldFail()) throw this.popFail();
    return { bytes: 0, checks: 0, elapsedTime: 0, errors: 0 };
  }
  async bisync(params: unknown) {
    this.calls.push({ method: "bisync", args: [params] });
    if (this.shouldFail()) throw this.popFail();
    return this.nextBisyncResult;
  }

  private shouldFail(): boolean {
    return this.failNext !== null;
  }
  private popFail(): Error {
    const e = this.failNext!;
    this.failNext = null;
    return e;
  }
}

let tmpRoot: string;
let configDir: string;
let server: Server;
let baseUrl: string;
let macFake: FakeSyncthing;
let qnapFake: FakeSyncthing;
let rcloneFake: FakeRclone;

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "synccenter-api-"));
  configDir = join(tmpRoot, "synccenter-config");
  for (const sub of ["rules", "folders", "hosts", "imports/github-gitignore", "schedules", "compiled"]) {
    mkdirSync(join(configDir, sub), { recursive: true });
  }
  writeFileSync(
    join(configDir, "rules", "base-binaries.yaml"),
    "name: base-binaries\nversion: 1\nexcludes:\n  - .DS_Store\n  - Thumbs.db\n",
  );
  writeFileSync(
    join(configDir, "rules", "divergent.yaml"),
    "name: divergent\nversion: 1\nexcludes:\n  - '(?d)*.bak'\n",
  );
  writeFileSync(
    join(configDir, "folders", "shared.yaml"),
    [
      "name: shared",
      "ruleset: base-binaries",
      "type: send-receive",
      "paths:",
      "  mac-studio: /Users/eric/Sync/shared",
      "  qnap-ts453d: /share/Sync/shared",
      "cloud:",
      "  rclone_remote: gdrive",
      "  remote_path: sync/shared",
    ].join("\n"),
  );
  writeFileSync(
    join(configDir, "folders", "no-cloud.yaml"),
    [
      "name: no-cloud",
      "ruleset: base-binaries",
      "type: send-receive",
      "paths:",
      "  mac-studio: /Users/eric/Sync/local",
    ].join("\n"),
  );
  writeFileSync(
    join(configDir, "hosts", "mac-studio.yaml"),
    [
      "name: mac-studio",
      "hostname: mac.local",
      "os: macos",
      "role: mesh-node",
      "syncthing:",
      "  install_method: brew",
      "  api_url: http://127.0.0.1:18384",
      "  api_key_ref: secrets/x.enc.yaml#mac-studio",
      "  device_id_ref: secrets/y.enc.yaml#mac-studio",
    ].join("\n"),
  );
  writeFileSync(
    join(configDir, "hosts", "qnap-ts453d.yaml"),
    [
      "name: qnap-ts453d",
      "hostname: qnap.local",
      "os: qnap",
      "role: cloud-edge",
      "syncthing:",
      "  install_method: docker",
      "  api_url: http://127.0.0.1:18385",
      "  api_key_ref: secrets/x.enc.yaml#qnap-ts453d",
      "  device_id_ref: secrets/y.enc.yaml#qnap-ts453d",
    ].join("\n"),
  );

  macFake = new FakeSyncthing();
  qnapFake = new FakeSyncthing();
  rcloneFake = new FakeRclone();
  const clients = new Map<string, SyncthingClient>();
  clients.set("mac-studio", macFake as unknown as SyncthingClient);
  clients.set("qnap-ts453d", qnapFake as unknown as SyncthingClient);

  const cfg = loadConfig({
    SC_CONFIG_DIR: configDir,
    SC_API_TOKEN: TOKEN,
    PORT: "0",
    SC_DB_PATH: ":memory:",
  });
  const registry = new HostRegistry({ cfg, clients });
  const { app } = buildApp({ cfg, registry, rclone: rcloneFake as unknown as RcloneClient });

  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  macFake.calls.length = 0;
  qnapFake.calls.length = 0;
  macFake.failNext = null;
  qnapFake.failNext = null;
  rcloneFake.calls.length = 0;
  rcloneFake.failNext = null;
  rcloneFake.nextBisyncResult = { jobid: 7 };
});

async function call(path: string, init: RequestInit = {}, withAuth = true): Promise<Response> {
  const headers = new Headers(init.headers);
  if (withAuth && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${TOKEN}`);
  }
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

describe("public + auth", () => {
  it("GET /health returns ok without auth", async () => {
    const r = await call("/health", {}, false);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, version: "0.0.1" });
  });

  it("rejects requests without a Bearer header", async () => {
    const r = await call("/folders", {}, false);
    expect(r.status).toBe(401);
  });
});

describe("config-repo reads", () => {
  it("GET /folders", async () => {
    const r = await call("/folders");
    expect(await r.json()).toEqual({ folders: ["no-cloud", "shared"] });
  });

  it("GET /folders/:name", async () => {
    const r = await call("/folders/shared");
    expect(await r.json()).toMatchObject({ name: "shared", ruleset: "base-binaries" });
  });

  it("GET /rules", async () => {
    const r = await call("/rules");
    expect(await r.json()).toEqual({ rules: ["base-binaries", "divergent"] });
  });

  it("GET /hosts", async () => {
    const r = await call("/hosts");
    expect(await r.json()).toEqual({ hosts: ["mac-studio", "qnap-ts453d"] });
  });

  it("POST /rules/:name/compile returns stignore + filter", async () => {
    const r = await call("/rules/base-binaries/compile", { method: "POST" });
    const body = (await r.json()) as { stignore: string; rcloneFilter: string };
    expect(body.stignore).toContain(".DS_Store");
    expect(body.rcloneFilter).toContain("- .DS_Store");
  });
});

describe("Syncthing-wired reads", () => {
  it("GET /hosts/:name/status calls getVersion + getStatus", async () => {
    const r = await call("/hosts/mac-studio/status");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { online: boolean; version: { version: string } };
    expect(body.online).toBe(true);
    expect(body.version.version).toBe("v1.30.0");
    expect(macFake.calls.map((c) => c.method).sort()).toEqual(["getStatus", "getVersion"]);
  });

  it("GET /hosts/:name/status 502s on adapter error", async () => {
    macFake.failNext = new SyncthingError("ECONNREFUSED", null, "/rest/system/version");
    const r = await call("/hosts/mac-studio/status");
    expect(r.status).toBe(502);
    expect((await r.json()) as { error: string }).toMatchObject({ error: expect.stringContaining("ECONNREFUSED") });
  });

  it("GET /folders/:name/state aggregates across hosts", async () => {
    const r = await call("/folders/shared/state");
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      folder: string;
      perHost: Array<{ host: string; ok: boolean }>;
    };
    expect(body.folder).toBe("shared");
    expect(body.perHost.map((p) => p.host).sort()).toEqual(["mac-studio", "qnap-ts453d"]);
    expect(body.perHost.every((p) => p.ok)).toBe(true);
    expect(macFake.calls[0]).toEqual({ method: "getFolderStatus", args: ["shared"] });
    expect(qnapFake.calls[0]).toEqual({ method: "getFolderStatus", args: ["shared"] });
  });

  it("aggregate state continues even if one host errors", async () => {
    qnapFake.failNext = new SyncthingError("daemon down", null, "/rest/db/status");
    const r = await call("/folders/shared/state");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { perHost: Array<{ host: string; ok: boolean; error?: string }> };
    const mac = body.perHost.find((p) => p.host === "mac-studio")!;
    const qnap = body.perHost.find((p) => p.host === "qnap-ts453d")!;
    expect(mac.ok).toBe(true);
    expect(qnap.ok).toBe(false);
    expect(qnap.error).toContain("daemon down");
  });
});

describe("pause / resume", () => {
  it("POST /folders/:name/pause fans out to every host", async () => {
    const r = await call("/folders/shared/pause", { method: "POST" });
    expect(r.status).toBe(200);
    expect(macFake.calls[0]).toEqual({ method: "pauseFolder", args: ["shared"] });
    expect(qnapFake.calls[0]).toEqual({ method: "pauseFolder", args: ["shared"] });
  });

  it("POST /folders/:name/resume fans out to every host", async () => {
    await call("/folders/shared/resume", { method: "POST" });
    expect(macFake.calls[0]).toEqual({ method: "resumeFolder", args: ["shared"] });
    expect(qnapFake.calls[0]).toEqual({ method: "resumeFolder", args: ["shared"] });
  });
});

describe("apply", () => {
  it("dry-run returns the compiled previews without touching daemons", async () => {
    const r = await call("/folders/shared/apply?dryRun=true", { method: "POST" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { dryRun: boolean; stignorePreview: string; payloadHash: string };
    expect(body.dryRun).toBe(true);
    expect(body.stignorePreview).toContain(".DS_Store");
    expect(body.payloadHash).toHaveLength(16);
    expect(macFake.calls).toEqual([]);
    expect(qnapFake.calls).toEqual([]);
  });

  it("apply calls setIgnores + scan on each host and records history", async () => {
    const r = await call("/folders/shared/apply", { method: "POST" });
    expect(r.status).toBe(200);
    expect(macFake.calls.map((c) => c.method)).toEqual(["setIgnores", "scan"]);
    expect(qnapFake.calls.map((c) => c.method)).toEqual(["setIgnores", "scan"]);
    const ignoresCall = macFake.calls[0]!;
    expect((ignoresCall.args[1] as string[])).toContain(".DS_Store");

    // Verify apply_history got a row.
    const hist = await call("/apply-history");
    const body = (await hist.json()) as { history: Array<{ target_name: string; result: string }> };
    expect(body.history[0]).toMatchObject({ target_name: "shared", result: "ok" });
  });

  it("apply returns 207 and logs error when a host fails", async () => {
    qnapFake.failNext = new SyncthingError("set ignores rejected", 400, "/rest/db/ignores");
    const r = await call("/folders/shared/apply", { method: "POST" });
    expect(r.status).toBe(207);
    const body = (await r.json()) as { perHost: Array<{ host: string; ok: boolean; error?: string }> };
    const mac = body.perHost.find((p) => p.host === "mac-studio")!;
    const qnap = body.perHost.find((p) => p.host === "qnap-ts453d")!;
    expect(mac.ok).toBe(true);
    expect(qnap.ok).toBe(false);
    expect(qnap.error).toContain("set ignores rejected");
  });

  it("apply refuses on engine divergence without allowDivergent", async () => {
    writeFileSync(
      join(configDir, "folders", "diverge.yaml"),
      [
        "name: diverge",
        "ruleset: divergent",
        "type: send-receive",
        "paths:",
        "  mac-studio: /tmp/x",
      ].join("\n"),
    );
    const r = await call("/folders/diverge/apply", { method: "POST" });
    expect(r.status).toBe(400);
    expect((await r.json()) as { error: string }).toMatchObject({ error: expect.stringContaining("engine divergence") });
  });
});

describe("legacy / stubbed", () => {
  it("POST /apply (no folder name) is still 501", async () => {
    const r = await call("/apply", { method: "POST" });
    expect(r.status).toBe(501);
  });
});

describe("rclone routes", () => {
  it("GET /rclone/version proxies to rclone client", async () => {
    const r = await call("/rclone/version");
    expect(r.status).toBe(200);
    expect((await r.json()) as { version: string }).toMatchObject({ version: "v1.69.0" });
    expect(rcloneFake.calls[0]!.method).toBe("getVersion");
  });

  it("GET /rclone/remotes returns the configured list", async () => {
    const r = await call("/rclone/remotes");
    expect(await r.json()).toEqual({ remotes: ["gdrive", "b2"] });
  });

  it("GET /rclone/jobs/:jobid passes the jobid through", async () => {
    const r = await call("/rclone/jobs/42");
    expect(r.status).toBe(200);
    expect(rcloneFake.calls[0]).toEqual({ method: "jobStatus", args: [42] });
  });

  it("GET /rclone/jobs/:jobid 400s on a bad jobid", async () => {
    const r = await call("/rclone/jobs/not-a-number");
    expect(r.status).toBe(400);
  });

  it("GET /rclone/stats forwards group query param", async () => {
    await call("/rclone/stats?group=foo");
    expect(rcloneFake.calls[0]).toEqual({ method: "getStats", args: ["foo"] });
  });

  it("returns 502 when the rclone client throws RcloneError", async () => {
    rcloneFake.failNext = new RcloneError("rcd down", 503, "core/version");
    const r = await call("/rclone/version");
    expect(r.status).toBe(502);
    expect((await r.json()) as { upstreamStatus: number }).toMatchObject({ upstreamStatus: 503 });
  });
});

describe("folder bisync", () => {
  it("404s for a missing folder", async () => {
    const r = await call("/folders/nonexistent/bisync", { method: "POST" });
    expect(r.status).toBe(404);
  });

  it("400s when the folder has no cloud edge", async () => {
    const r = await call("/folders/no-cloud/bisync", { method: "POST" });
    expect(r.status).toBe(400);
    expect((await r.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("no cloud edge"),
    });
  });

  it("409s when the compiled filter is missing on disk", async () => {
    const r = await call("/folders/shared/bisync", { method: "POST" });
    expect(r.status).toBe(409);
    expect((await r.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("filter.rclone missing"),
    });
  });

  it("triggers a bisync with the right path1/path2/filtersFile once compiled", async () => {
    // First materialize compiled/<folder>/filter.rclone via apply.
    const applyR = await call("/folders/shared/apply", { method: "POST" });
    expect(applyR.status).toBe(200);
    // (apply writes nothing to disk in this implementation — it pushes to Syncthing.
    //  We need to write the compiled filter to disk manually for the bisync test.)
    mkdirSync(join(configDir, "compiled", "shared"), { recursive: true });
    writeFileSync(join(configDir, "compiled", "shared", "filter.rclone"), "- .DS_Store\n+ **\n");

    rcloneFake.calls.length = 0;
    const r = await call("/folders/shared/bisync?async=true&dryRun=true", { method: "POST" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { jobid?: number; path1: string; path2: string };
    expect(body.jobid).toBe(7);
    expect(body.path2).toBe("gdrive:sync/shared");
    // path1 should be the QNAP path (the cloud-edge host).
    expect(body.path1).toBe("/share/Sync/shared");

    const bisyncCall = rcloneFake.calls.find((c) => c.method === "bisync")!;
    const args = bisyncCall.args[0] as { filtersFile: string; async: boolean; dryRun: boolean };
    expect(args.filtersFile).toBe(join(configDir, "compiled", "shared", "filter.rclone"));
    expect(args.async).toBe(true);
    expect(args.dryRun).toBe(true);
  });

  it("returns 502 when rclone errors during bisync", async () => {
    rcloneFake.failNext = new RcloneError("workdir locked", 400, "sync/bisync");
    const r = await call("/folders/shared/bisync", { method: "POST" });
    expect(r.status).toBe(502);
  });
});

describe("registry edge cases", () => {
  it("GET /hosts/:name/status 404s for an unknown host", async () => {
    const r = await call("/hosts/nope/status");
    expect(r.status).toBe(404);
  });
});
