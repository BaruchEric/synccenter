import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { HostRegistry } from "../src/registry.ts";

const TOKEN = "test-token-of-sufficient-length-1234567890";
const SHELL = '<!doctype html><title>SyncCenter</title><script src="/app/assets/app.js"></script>';

let tmpRoot: string;
let withWeb: { server: Server; url: string };
let withoutWeb: { server: Server; url: string };

function serve(env: NodeJS.ProcessEnv): Promise<{ server: Server; url: string }> {
  const cfg = loadConfig(env);
  const registry = new HostRegistry({ cfg, clients: new Map() });
  const { app } = buildApp({ cfg, registry });
  return new Promise((resolve) => {
    const s = app.listen(0, () => {
      const { port } = s.address() as AddressInfo;
      resolve({ server: s, url: `http://127.0.0.1:${port}` });
    });
  });
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "synccenter-webmount-"));
  const configDir = join(tmpRoot, "config");
  for (const d of ["rules", "folders", "hosts", "imports", "compiled"]) {
    mkdirSync(join(configDir, d), { recursive: true });
  }
  // Stand-in for `apps/web/dist` — the mount must not care what is in it.
  const dist = join(tmpRoot, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), SHELL);
  writeFileSync(join(dist, "assets", "app.js"), "console.log('bundle');");

  const base = { SC_CONFIG_DIR: configDir, SC_API_TOKEN: TOKEN, PORT: "0", SC_DB_PATH: ":memory:" };
  withWeb = await serve({ ...base, SC_WEB_DIR: dist });
  withoutWeb = await serve(base);
});

afterAll(async () => {
  for (const s of [withWeb?.server, withoutWeb?.server]) {
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("SPA mount at /app", () => {
  // No Authorization header anywhere in this block on purpose: a browser cannot
  // send one on its first navigation, so the shell has to be public.
  it("serves the shell unauthenticated", async () => {
    const r = await fetch(`${withWeb.url}/app/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("html");
    expect(await r.text()).toContain("/app/assets/app.js");
  });

  it("serves the shell for client-side deep links that have no file behind them", async () => {
    for (const path of ["/app/activity", "/app/folders/arik/edit", "/app/conflicts"]) {
      const r = await fetch(`${withWeb.url}${path}`);
      expect(r.status, path).toBe(200);
      expect(await r.text(), path).toContain("/app/assets/app.js");
    }
  });

  it("serves real asset files rather than the fallback", async () => {
    const r = await fetch(`${withWeb.url}/app/assets/app.js`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("console.log('bundle');");
  });

  // The whole reason the SPA lives under /app: these paths are the SPA's client
  // routes AND this API's routes. If the mount ever shadowed them, the CLI, the
  // MCP server and Prometheus would start receiving HTML.
  it("leaves the API's identically-named root routes untouched", async () => {
    for (const path of ["/folders", "/rules", "/hosts", "/conflicts", "/runs"]) {
      const r = await fetch(`${withWeb.url}${path}`);
      expect(r.status, path).toBe(401);
      expect(r.headers.get("content-type"), path).toContain("json");
    }
  });

  // `/app` must not become a prefix match for unrelated paths.
  it("does not capture paths that merely start with the letters 'app'", async () => {
    const r = await fetch(`${withWeb.url}/app-not-a-route`);
    expect(r.status).toBe(401);
    expect(r.headers.get("content-type")).toContain("json");
  });

  it("mounts nothing when SC_WEB_DIR is unset, so tests and dev are unaffected", async () => {
    const r = await fetch(`${withoutWeb.url}/app/`);
    expect(r.status).toBe(401);
    expect(r.headers.get("content-type")).toContain("json");
  });

  it("keeps the HTMX console and public routes reachable", async () => {
    expect((await fetch(`${withWeb.url}/health`)).status).toBe(200);
    const ui = await fetch(`${withWeb.url}/ui/login`);
    expect(ui.status).toBe(200);
    expect(ui.headers.get("content-type")).toContain("html");
  });
});
