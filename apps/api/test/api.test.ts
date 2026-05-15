import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncthingClient, SyncthingError } from "@synccenter/adapters";
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

let tmpRoot: string;
let configDir: string;
let server: Server;
let baseUrl: string;
let macFake: FakeSyncthing;
let qnapFake: FakeSyncthing;

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
  const { app } = buildApp({ cfg, registry });

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
    expect(await r.json()).toEqual({ folders: ["shared"] });
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

  it("POST /folders/:name/bisync stays 501 until rclone adapter lands", async () => {
    const r = await call("/folders/shared/bisync", { method: "POST" });
    expect(r.status).toBe(501);
  });
});

describe("registry edge cases", () => {
  it("GET /hosts/:name/status 404s for an unknown host", async () => {
    const r = await call("/hosts/nope/status");
    expect(r.status).toBe(404);
  });
});
