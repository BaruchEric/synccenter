import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RcloneClient, RcloneError, SyncthingClient, SyncthingError } from "@synccenter/adapters";
import { buildApp, type BuiltApp } from "../src/app.ts";
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
  /** Overridable so a test can hold a job open, finish it, or fail it. */
  public nextJobStatus: { finished: boolean; success?: boolean; error?: string } = {
    finished: true,
    success: true,
  };
  public nextStats: Record<string, unknown> = { bytes: 0, checks: 0, elapsedTime: 0, errors: 0 };

  async jobStatus(jobid: number) {
    this.calls.push({ method: "jobStatus", args: [jobid] });
    if (this.shouldFail()) throw this.popFail();
    return {
      id: jobid,
      startTime: "2026-05-14T00:00:00Z",
      duration: 1,
      ...this.nextJobStatus,
    };
  }
  async getStats(group?: string) {
    this.calls.push({ method: "getStats", args: [group] });
    if (this.shouldFail()) throw this.popFail();
    return this.nextStats;
  }
  async stopJob(jobid: number) {
    this.calls.push({ method: "stopJob", args: [jobid] });
    if (this.shouldFail()) throw this.popFail();
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
let tracker: BuiltApp["tracker"];
let bus: BuiltApp["bus"];

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
      "  gdrive: sync/shared",
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
    join(configDir, "hosts", "gdrive.yaml"),
    ["name: gdrive", "engine: rclone", "remote: gdrive"].join("\n"),
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

  // Seed a ruleset with imports so the imports routes have something to scan.
  writeFileSync(
    join(configDir, "rules", "with-import.yaml"),
    "name: with-import\nversion: 1\nimports:\n  - github://github/gitignore/Node\nexcludes:\n  - '**/dist/'\n",
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
  const importerFetch = (async (input: Request | string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/Node.gitignore")) {
      return new Response("*.log\nnode_modules/\n", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  const built = buildApp({
    cfg,
    registry,
    rclone: rcloneFake as unknown as RcloneClient,
    importerFetch,
  });
  const app = built.app;
  // buildApp deliberately leaves the poller stopped; drive it by hand so the
  // suite never depends on (or is held open by) a live interval.
  tracker = built.tracker;
  bus = built.bus;

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
  rcloneFake.nextJobStatus = { finished: true, success: true };
  rcloneFake.nextStats = { bytes: 0, checks: 0, elapsedTime: 0, errors: 0 };
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

  it("GET /metrics is public and includes live host + folder gauges", async () => {
    const r = await call("/metrics", {}, false);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain("synccenter_up 1");
    expect(body).toContain('synccenter_host_online{host="mac-studio"} 1');
    expect(body).toContain('synccenter_host_online{host="qnap-ts453d"} 1');
    expect(body).toMatch(/synccenter_folder_state_info\{folder="shared",host="mac-studio",state="idle"\} 1/);
    expect(body).toContain("synccenter_conflicts_open 0");
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
    expect(await r.json()).toEqual({ rules: ["base-binaries", "divergent", "with-import"] });
  });

  it("GET /hosts", async () => {
    const r = await call("/hosts");
    expect(await r.json()).toEqual({ hosts: ["gdrive", "mac-studio", "qnap-ts453d"] });
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
  // The new planner-based /folders/:name/apply spawns sops via createSecretsResolver
  // to dereference device_id_ref + api_key_ref before building a SyncthingClient pool.
  // Unit tests here don't have sops or encrypted secrets, so we exercise only the
  // request-validation surface (CONFIRM_REQUIRED). Real end-to-end coverage lives
  // behind SC_E2E in the live-environment harness.

  it("apply requires confirm:true in body", async () => {
    const r = await call("/folders/shared/apply", { method: "POST" });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFIRM_REQUIRED");
  });

  it("apply with confirm but no sops returns a structured error (not a crash)", async () => {
    const r = await call("/folders/shared/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true, dryRun: true }),
    });
    // 4xx (manifest load / secrets resolution) or 5xx (sops missing) — never an unhandled crash.
    expect([400, 500]).toContain(r.status);
    const body = (await r.json()) as { error: { code: string; message: string } };
    expect(body.error).toBeDefined();
    expect(typeof body.error.message).toBe("string");
  });
});

describe("folder CRUD: update / disable / delete", () => {
  const json = (body: unknown): RequestInit => ({
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  // Operate on a folder this block owns. Mutating the shared fixtures would
  // leak into every test that runs after it.
  const SCRATCH = "crud-scratch";
  const base = { ruleset: "base-binaries", type: "send-receive", paths: { "mac-studio": "/tmp/crud" } };

  beforeEach(async () => {
    await call(`/folders/${SCRATCH}`, { method: "DELETE", ...json({ confirm: true }) });
    await call("/folders", { method: "POST", ...json({ name: SCRATCH, ...base }) });
  });
  afterAll(async () => {
    await call(`/folders/${SCRATCH}`, { method: "DELETE", ...json({ confirm: true }) });
  });

  it("PUT replaces a manifest in place", async () => {
    const r = await call(`/folders/${SCRATCH}`, {
      method: "PUT",
      ...json({ ...base, type: "send-only" }),
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { folder: { type: string } }).folder.type).toBe("send-only");
    expect(((await (await call(`/folders/${SCRATCH}`)).json()) as { type: string }).type).toBe("send-only");
  });

  it("PUT refuses a rename — that would orphan compiled artifacts and the folder ID", async () => {
    const r = await call(`/folders/${SCRATCH}`, { method: "PUT", ...json({ name: "renamed", ...base }) });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { message: string } }).error.message).toContain("cannot rename");
  });

  it("PUT on a folder that does not exist is 404, not a silent create", async () => {
    const r = await call("/folders/ghost", { method: "PUT", ...json(base) });
    expect(r.status).toBe(404);
  });

  it("disable writes enabled:false; enable removes the key again", async () => {
    expect((await call(`/folders/${SCRATCH}/disable`, { method: "POST" })).status).toBe(200);
    expect(((await (await call(`/folders/${SCRATCH}`)).json()) as { enabled?: boolean }).enabled).toBe(false);

    expect((await call(`/folders/${SCRATCH}/enable`, { method: "POST" })).status).toBe(200);
    // Enabled is the default, so the key should be gone rather than `true`.
    expect(((await (await call(`/folders/${SCRATCH}`)).json()) as { enabled?: boolean }).enabled).toBeUndefined();
  });

  it("a disabled folder refuses apply", async () => {
    await call(`/folders/${SCRATCH}/disable`, { method: "POST" });
    const r = await call(`/folders/${SCRATCH}/apply`, { method: "POST", ...json({ confirm: true, dryRun: true }) });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { message: string } }).error.message).toContain("disabled");
  });

  it("DELETE needs confirm:true, then removes only the manifest", async () => {
    const guard = await call(`/folders/${SCRATCH}`, { method: "DELETE" });
    expect(guard.status).toBe(400);
    expect(((await guard.json()) as { error: { code: string } }).error.code).toBe("CONFIRM_REQUIRED");

    expect((await call(`/folders/${SCRATCH}`, { method: "DELETE", ...json({ confirm: true }) })).status).toBe(200);
    const listed = (await (await call("/folders")).json()) as { folders: string[] };
    expect(listed.folders).not.toContain(SCRATCH);
    expect((await call(`/folders/${SCRATCH}`, { method: "DELETE", ...json({ confirm: true }) })).status).toBe(404);
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

  it("400s when the folder has no rclone member", async () => {
    const r = await call("/folders/no-cloud/bisync", { method: "POST" });
    expect(r.status).toBe(400);
    expect((await r.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("no rclone member"),
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
    // Compilation is per-RULESET, so the artifact lives under the ruleset name
    // (`base-binaries`), not the folder name. Keying this off the folder is the
    // bug that made every Run 409 with "filter.rclone missing".
    mkdirSync(join(configDir, "compiled", "base-binaries"), { recursive: true });
    writeFileSync(join(configDir, "compiled", "base-binaries", "filter.rclone"), "- .DS_Store\n+ **\n");

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
    expect(args.filtersFile).toBe(join(configDir, "compiled", "base-binaries", "filter.rclone"));
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

describe("imports routes", () => {
  it("GET /imports lists imports with cache state", async () => {
    const r = await call("/imports");
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      imports: Array<{ uri: string; cached: boolean }>;
      perRuleset: Record<string, string[]>;
    };
    const node = body.imports.find((i) => i.uri === "github://github/gitignore/Node");
    expect(node).toBeDefined();
    expect(node!.cached).toBe(false);
    expect(body.perRuleset["with-import"]).toEqual(["github://github/gitignore/Node"]);
  });

  it("POST /imports/refresh fetches via injected fetch and updates checksums", async () => {
    const r = await call("/imports/refresh", { method: "POST" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      results: Array<{ uri: string; status: string; sha256?: string }>;
    };
    const node = body.results.find((x) => x.uri === "github://github/gitignore/Node")!;
    expect(node.status).toBe("fetched");
    expect(node.sha256).toHaveLength(64);

    // Subsequent list shows cached=true.
    const listed = await call("/imports");
    const second = (await listed.json()) as { imports: Array<{ uri: string; cached: boolean }> };
    const after = second.imports.find((i) => i.uri === "github://github/gitignore/Node")!;
    expect(after.cached).toBe(true);
  });

  it("POST /imports/refresh-one fails with 400 when no ?uri", async () => {
    const r = await call("/imports/refresh-one", { method: "POST" });
    expect(r.status).toBe(400);
  });

  it("POST /imports/refresh-one returns 502 on fetch failure", async () => {
    const r = await call("/imports/refresh-one?uri=github://github/gitignore/DoesNotExist", { method: "POST" });
    expect(r.status).toBe(502);
    const body = (await r.json()) as { result: { status: string; error?: string } };
    expect(body.result.status).toBe("error-fetch");
  });

  it("after refresh, dev-monorepo-like compile actually works", async () => {
    // The fixture rule "with-import" imports Node; first refresh, then compile.
    await call("/imports/refresh", { method: "POST" });
    const r = await call("/rules/with-import/compile", { method: "POST" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { stignore: string };
    expect(body.stignore).toContain("node_modules/");
    expect(body.stignore).toContain("**/dist/");
  });
});

describe("run tracking + live progress", () => {
  /** The bisync route only registers a run once the filter exists. */
  const armFilter = () => {
    mkdirSync(join(configDir, "compiled", "base-binaries"), { recursive: true });
    writeFileSync(join(configDir, "compiled", "base-binaries", "filter.rclone"), "+ **\n");
  };

  // Runs are server state that outlives a test. Settle whatever a previous one
  // left in flight, or the next tick finishes them all at once and every
  // history assertion counts somebody else's rows.
  beforeEach(async () => {
    rcloneFake.nextJobStatus = { finished: true, success: true };
    await tracker.tick();
    rcloneFake.calls.length = 0;
  });

  it("names a stats group and hands it to rclone", async () => {
    armFilter();
    const r = await call("/folders/shared/bisync?async=true", { method: "POST" });
    expect(r.status).toBe(200);
    const args = rcloneFake.calls.find((c) => c.method === "bisync")!.args[0] as {
      statsGroup: string;
    };
    // Guessing rclone's `job/<id>` group yields all zeros for bisync, so the
    // group has to be one we chose and can look up later.
    expect(args.statsGroup).toMatch(/^sc\/bisync\/shared\//);
  });

  it("registers a run and holds off on history until the job ends", async () => {
    armFilter();
    const before = ((await (await call("/apply-history")).json()) as { history: unknown[] }).history
      .length;

    rcloneFake.nextJobStatus = { finished: false };
    const started = (await (
      await call("/folders/shared/bisync?async=true", { method: "POST" })
    ).json()) as { runId: number };
    expect(started.runId).toBeGreaterThan(0);

    const running = (await (await call(`/runs/${started.runId}`)).json()) as {
      run: { state: string; phase: string };
    };
    expect(running.run.state).toBe("running");

    // A run in flight must not already be sitting in history as a finished
    // event — the timeline would show it both ways at once.
    const mid = ((await (await call("/apply-history")).json()) as { history: unknown[] }).history;
    expect(mid.length).toBe(before);
  });

  it("moves starting → checking → transferring as the stats fill in", async () => {
    armFilter();
    rcloneFake.nextJobStatus = { finished: false };
    const { runId } = (await (
      await call("/folders/shared/bisync?async=true", { method: "POST" })
    ).json()) as { runId: number };

    const phase = async () =>
      ((await (await call(`/runs/${runId}`)).json()) as { run: { phase: string } }).run.phase;

    expect(await phase()).toBe("starting");

    // Listing: bisync walks both trees before moving a byte, so there is no
    // denominator yet. Reporting that as 0% would read as stalled.
    rcloneFake.nextStats = { bytes: 0, totalBytes: 0, checks: 1200, listed: 1500, errors: 0 };
    await tracker.tick();
    expect(await phase()).toBe("checking");

    rcloneFake.nextStats = { bytes: 500, totalBytes: 1000, checks: 1800, errors: 0, speed: 250 };
    await tracker.tick();
    const t = (await (await call(`/runs/${runId}`)).json()) as {
      run: { phase: string; fraction: number; bytes: number };
    };
    expect(t.run.phase).toBe("transferring");
    expect(t.run.fraction).toBe(0.5);
    expect(t.run.bytes).toBe(500);
  });

  it("writes exactly one history row, with the real result, when the job ends", async () => {
    armFilter();
    rcloneFake.nextJobStatus = { finished: false };
    const { runId } = (await (
      await call("/folders/shared/bisync?async=true", { method: "POST" })
    ).json()) as { runId: number };

    const before = ((await (await call("/apply-history")).json()) as { history: unknown[] }).history
      .length;

    rcloneFake.nextStats = { bytes: 4096, totalBytes: 4096, checks: 9, errors: 0 };
    rcloneFake.nextJobStatus = { finished: true, success: true };
    await tracker.tick();

    const done = (await (await call(`/runs/${runId}`)).json()) as {
      run: { state: string; phase: string; finished_at: string };
    };
    expect(done.run.state).toBe("done");
    expect(done.run.phase).toBe("finished");
    expect(done.run.finished_at).toBeTruthy();

    const after = ((await (await call("/apply-history")).json()) as {
      history: Array<{ result: string; target_name: string; note: string }>;
    }).history;
    expect(after.length).toBe(before + 1);
    expect(after[0]!.result).toBe("ok");
    expect(after[0]!.target_name).toBe("shared");
    expect(after[0]!.note).toContain("bisync");

    // And a settled run must not be polled again.
    rcloneFake.calls.length = 0;
    await tracker.tick();
    expect(rcloneFake.calls.filter((c) => c.method === "jobStatus")).toHaveLength(0);
  });

  it("marks the run failed when rclone reports an error", async () => {
    armFilter();
    rcloneFake.nextJobStatus = { finished: false };
    const { runId } = (await (
      await call("/folders/shared/bisync?async=true", { method: "POST" })
    ).json()) as { runId: number };

    rcloneFake.nextJobStatus = { finished: true, success: false, error: "path1 lock held" };
    await tracker.tick();

    const r = (await (await call(`/runs/${runId}`)).json()) as {
      run: { state: string; error: string };
    };
    expect(r.run.state).toBe("failed");
    expect(r.run.error).toBe("path1 lock held");
  });

  it("stops a running job on request and refuses to stop a settled one", async () => {
    armFilter();
    rcloneFake.nextJobStatus = { finished: false };
    const { runId } = (await (
      await call("/folders/shared/bisync?async=true", { method: "POST" })
    ).json()) as { runId: number };

    const stopped = await call(`/runs/${runId}/stop`, { method: "POST" });
    expect(stopped.status).toBe(200);
    expect(rcloneFake.calls.some((c) => c.method === "stopJob")).toBe(true);
    expect(((await stopped.json()) as { run: { state: string } }).run.state).toBe("stopped");

    const again = await call(`/runs/${runId}/stop`, { method: "POST" });
    expect(again.status).toBe(409);
  });

  it("404s for an unknown run", async () => {
    expect((await call("/runs/999999")).status).toBe(404);
    expect((await call("/runs/999999/stop", { method: "POST" })).status).toBe(404);
  });

  it("lists runs newest first", async () => {
    armFilter();
    rcloneFake.nextJobStatus = { finished: false };
    await call("/folders/shared/bisync?async=true", { method: "POST" });
    const body = (await (await call("/runs?limit=5")).json()) as {
      runs: Array<{ id: number }>;
      activeCount: number;
    };
    expect(body.runs.length).toBeGreaterThan(0);
    expect(body.runs[0]!.id).toBeGreaterThan(body.runs[body.runs.length - 1]!.id - 1);
    expect(body.activeCount).toBeGreaterThan(0);
  });
});

describe("event stream", () => {
  it("opens with the current runs and pushes what changes after", async () => {
    const ctrl = new AbortController();
    const res = await call("/events", { signal: ctrl.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // Buffering proxies are the usual reason a stream arrives in bursts.
    expect(res.headers.get("cache-control")).toContain("no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const frames: string[] = [];
    const pump = (async () => {
      let buf = "";
      while (frames.length < 2) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (frame.includes("data:")) frames.push(frame);
        }
      }
    })();

    // Give the hello frame a moment, then cause a change.
    await Bun.sleep(50);
    bus.emit({ type: "folder", folder: "shared", action: "applied" });
    await pump;
    ctrl.abort();

    expect(frames[0]).toContain("event: hello");
    expect(frames[1]).toContain("event: folder");
    expect(frames[1]).toContain('"action":"applied"');
  });

  it("requires a token like every other route", async () => {
    expect((await call("/events", {}, false)).status).toBe(401);
  });
});

describe("manifest writes preserve the file", () => {
  const COMMENTED = [
    "# Why this folder exists at all.",
    "name: commented",
    "ruleset: base-binaries",
    "type: send-receive",
    "",
    "paths:",
    "  # The Mac is the one people actually type on.",
    "  mac-studio: /Users/eric/Sync/commented",
    "",
    "bisync:",
    "  schedule: \"0 4 * * *\"",
    "  flags:",
    "    # Second-precision modtimes on one side, milliseconds on the other.",
    "    - --modify-window=1s",
    "overrides:",
    "  mac-studio:",
    "    ignore_perms: false",
    "ignore_perms: true",
    "",
  ].join("\n");

  const file = () => join(configDir, "folders", "commented.yaml");
  beforeEach(() => writeFileSync(file(), COMMENTED));

  it("keeps every comment when disabling and re-enabling", async () => {
    expect((await call("/folders/commented/disable", { method: "POST" })).status).toBe(200);
    const off = readFileSync(file(), "utf8");
    expect(off).toContain("# Why this folder exists at all.");
    expect(off).toContain("# Second-precision modtimes");
    expect(off).toContain("enabled: false");

    expect((await call("/folders/commented/enable", { method: "POST" })).status).toBe(200);
    const on = readFileSync(file(), "utf8");
    expect(on).not.toContain("enabled:");
    expect(on).toContain("# The Mac is the one people actually type on.");
  });

  it("leaves every other key alone across a disable/enable cycle", async () => {
    const before = readFileSync(file(), "utf8");
    await call("/folders/commented/disable", { method: "POST" });
    await call("/folders/commented/enable", { method: "POST" });
    const after = readFileSync(file(), "utf8");

    // Parking a folder must not be a whole-file rewrite. `overrides` is the
    // canary: it is schema-known but easy to lose to a validate-and-re-emit
    // round trip, and losing it silently changes how a host syncs.
    expect(after).toContain("overrides:");
    expect(after).toContain("ignore_perms: false");
    expect(after).toBe(before);
  });

  it("refuses to write at all when the file has a key the schema rejects", async () => {
    writeFileSync(file(), `${COMMENTED}mystery_key: 1\n`);
    const before = readFileSync(file(), "utf8");
    const r = await call("/folders/commented/disable", { method: "POST" });
    expect(r.status).toBe(400);
    // Refusing is the safe failure; half-writing the file is not.
    expect(readFileSync(file(), "utf8")).toBe(before);
  });

  it("keeps the comments of keys an update did not touch", async () => {
    const current = (await (await call("/folders/commented")).json()) as Record<string, unknown>;
    const r = await call("/folders/commented", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      // Change only the schedule; everything else is resubmitted unchanged.
      body: JSON.stringify({ ...current, bisync: { schedule: "30 5 * * *", flags: ["--modify-window=1s"] } }),
    });
    expect(r.status).toBe(200);

    const after = readFileSync(file(), "utf8");
    expect(after).toContain("30 5 * * *");
    // Untouched keys keep their comments...
    expect(after).toContain("# Why this folder exists at all.");
    expect(after).toContain("# The Mac is the one people actually type on.");
    expect(after).toContain("ignore_perms: true");
    // ...while the subtree that genuinely changed is re-emitted.
    expect(after).not.toContain("# Second-precision modtimes");
  });

  it("drops a key that the update removed", async () => {
    const current = (await (await call("/folders/commented")).json()) as Record<string, unknown>;
    delete current.ignore_perms;
    const r = await call("/folders/commented", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(current),
    });
    expect(r.status).toBe(200);
    const after = readFileSync(file(), "utf8");
    // Anchored: `ignore_perms` also appears nested under overrides, which must
    // survive — only the top-level key was removed.
    expect(after).not.toMatch(/^ignore_perms:/m);
    expect(after).toContain("overrides:");
  });
});

describe("bisync flags reach rclone", () => {
  const armFilter = () => {
    mkdirSync(join(configDir, "compiled", "base-binaries"), { recursive: true });
    writeFileSync(join(configDir, "compiled", "base-binaries", "filter.rclone"), "+ **\n");
  };
  const withFlags = (flags: string[]) =>
    writeFileSync(
      join(configDir, "folders", "flagged.yaml"),
      [
        "name: flagged",
        "ruleset: base-binaries",
        "type: send-receive",
        "paths:",
        "  qnap-ts453d: /share/Sync/flagged",
        "  gdrive: sync/flagged",
        "bisync:",
        "  flags:",
        ...flags.map((f) => `    - ${f}`),
      ].join("\n"),
    );

  beforeEach(armFilter);

  it("carries the manifest's flags — the scheduled leg's semantics, on demand", async () => {
    withFlags([
      "--resilient",
      "--recover",
      "--max-lock=2m",
      "--compare=size,modtime",
      "--modify-window=1s",
    ]);
    rcloneFake.calls.length = 0;
    const r = await call("/folders/flagged/bisync?async=true", { method: "POST" });
    expect(r.status).toBe(200);

    const args = rcloneFake.calls.find((c) => c.method === "bisync")!.args[0] as {
      extra: Record<string, unknown>;
    };
    expect(args.extra.resilient).toBe(true);
    expect(args.extra.recover).toBe(true);
    expect(args.extra.maxLock).toBe("2m");
    expect(args.extra.compare).toBe("size,modtime");
    // The one whose absence aborts the run on NAS-seconds vs Drive-milliseconds.
    expect(args.extra._config).toEqual({ ModifyWindow: "1s" });
  });

  it("refuses rather than running with a flag it cannot express", async () => {
    withFlags(["--resilient", "--some-future-bisync-thing"]);
    const r = await call("/folders/flagged/bisync?async=true", { method: "POST" });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("UNSUPPORTED_BISYNC_FLAG");
    expect(body.error.message).toContain("--some-future-bisync-thing");
  });

  it("warns, but still runs, when a backend option cannot be set per call", async () => {
    // --drive-skip-gdocs configures the remote. Passing it as a connection
    // string would change the path pair, and bisync keys its session state on
    // that — an on-demand run would fork off the scheduled one's listings.
    withFlags(["--resilient", "--drive-skip-gdocs"]);
    const r = await call("/folders/flagged/bisync?async=true", { method: "POST" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { warnings?: string[] };
    expect(body.warnings?.join(" ")).toContain("--drive-skip-gdocs");
    expect(body.warnings?.join(" ")).toContain("rclone.conf");
    // Must not claim the option is missing — it may already be set on the
    // remote, which is exactly where it belongs.
    expect(body.warnings?.join(" ")).not.toContain("add it to the remote");
  });

  it("names the filter path the rclone host would see", async () => {
    withFlags(["--resilient"]);
    const r = await call("/folders/flagged/bisync?async=true", { method: "POST" });
    const body = (await r.json()) as { filtersFile: string };
    // No SC_RCLONE_FILTERS_DIR in this suite, so it stays the local path.
    expect(body.filtersFile).toBe(join(configDir, "compiled", "base-binaries", "filter.rclone"));
  });
});
