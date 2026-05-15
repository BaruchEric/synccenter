import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";

const TOKEN = "test-token-of-sufficient-length-1234567890";

let tmpRoot: string;
let configDir: string;
let server: Server;
let baseUrl: string;

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
    join(configDir, "folders", "example.yaml"),
    "name: example\nruleset: base-binaries\ntype: send-receive\npaths:\n  mac: /tmp/x\n",
  );
  writeFileSync(
    join(configDir, "hosts", "mac.yaml"),
    "name: mac\nhostname: mac.local\nos: macos\nrole: mesh-node\n",
  );

  const cfg = loadConfig({
    SC_CONFIG_DIR: configDir,
    SC_API_TOKEN: TOKEN,
    PORT: "0",
    SC_DB_PATH: ":memory:",
  });
  const { app } = buildApp({ cfg });
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

async function call(path: string, init: RequestInit = {}, withAuth = true): Promise<Response> {
  const headers = new Headers(init.headers);
  if (withAuth && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${TOKEN}`);
  }
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

describe("public endpoints", () => {
  it("GET /health returns ok without auth", async () => {
    const r = await call("/health", {}, false);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, version: "0.0.1" });
  });

  it("GET /metrics returns prom text without auth", async () => {
    const r = await call("/metrics", {}, false);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain("synccenter_up 1");
    expect(body).toContain("synccenter_info");
  });
});

describe("auth", () => {
  it("rejects requests without a Bearer header (401)", async () => {
    const r = await call("/folders", {}, false);
    expect(r.status).toBe(401);
  });

  it("rejects an invalid token (401)", async () => {
    const r = await fetch(`${baseUrl}/folders`, {
      headers: { authorization: "Bearer wrong-token-value-but-similar-length" },
    });
    expect(r.status).toBe(401);
  });
});

describe("folders routes", () => {
  it("GET /folders lists by name", async () => {
    const r = await call("/folders");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ folders: ["example"] });
  });

  it("GET /folders/:name returns parsed YAML", async () => {
    const r = await call("/folders/example");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ name: "example", ruleset: "base-binaries" });
  });

  it("GET /folders/:name 404s for missing", async () => {
    const r = await call("/folders/nope");
    expect(r.status).toBe(404);
  });

  it("POST /folders/:name/pause stubs to 501", async () => {
    const r = await call("/folders/example/pause", { method: "POST" });
    expect(r.status).toBe(501);
  });
});

describe("rules routes", () => {
  it("GET /rules lists rulesets", async () => {
    const r = await call("/rules");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ rules: ["base-binaries", "divergent"] });
  });

  it("GET /rules/:name returns parsed ruleset", async () => {
    const r = await call("/rules/base-binaries");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { name: string; excludes: string[] };
    expect(body.name).toBe("base-binaries");
    expect(body.excludes).toContain(".DS_Store");
  });

  it("POST /rules/:name/compile returns stignore + filter", async () => {
    const r = await call("/rules/base-binaries/compile", { method: "POST" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { stignore: string; rcloneFilter: string; warnings: string[] };
    expect(body.stignore).toContain(".DS_Store");
    expect(body.rcloneFilter).toContain("- .DS_Store");
    expect(body.warnings).toEqual([]);
  });

  it("POST /rules/:name/compile 400s on divergence without allowDivergent", async () => {
    const r = await call("/rules/divergent/compile", { method: "POST" });
    expect(r.status).toBe(400);
    expect((await r.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("engine divergence"),
    });
  });

  it("POST /rules/:name/compile succeeds when allowDivergent=true", async () => {
    const r = await call("/rules/divergent/compile?allowDivergent=true", { method: "POST" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { warnings: string[] };
    expect(body.warnings.length).toBe(1);
  });

  it("GET /rules/:name 404s for missing", async () => {
    const r = await call("/rules/nope");
    expect(r.status).toBe(404);
  });
});

describe("hosts routes", () => {
  it("GET /hosts lists by name", async () => {
    const r = await call("/hosts");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ hosts: ["mac"] });
  });

  it("GET /hosts/:name returns parsed YAML", async () => {
    const r = await call("/hosts/mac");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ name: "mac", os: "macos" });
  });
});

describe("system routes", () => {
  it("GET /conflicts returns empty list", async () => {
    const r = await call("/conflicts");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ conflicts: [] });
  });

  it("GET /jobs returns empty list", async () => {
    const r = await call("/jobs");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ jobs: [] });
  });

  it("POST /apply stubs to 501", async () => {
    const r = await call("/apply", { method: "POST" });
    expect(r.status).toBe(501);
  });

  it("404 for unknown paths", async () => {
    const r = await call("/nothing-here");
    expect(r.status).toBe(404);
  });
});

describe("config validation", () => {
  it("loadConfig refuses a short token", () => {
    expect(() =>
      loadConfig({ SC_CONFIG_DIR: configDir, SC_API_TOKEN: "short" }),
    ).toThrow(/at least 16/);
  });

  it("loadConfig refuses a missing config dir", () => {
    expect(() =>
      loadConfig({ SC_CONFIG_DIR: "/nonexistent/path", SC_API_TOKEN: TOKEN }),
    ).toThrow(/not a directory/);
  });
});
