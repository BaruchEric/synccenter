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

  it("keeps the public routes reachable", async () => {
    expect((await fetch(`${withWeb.url}/health`)).status).toBe(200);
  });
});

// `/ui/jobs` and `/app/folders` were two views of the same folder manifests.
// With a bundle configured the React one is the only one, and /ui exists purely
// to carry old bookmarks across.
describe("the HTMX console retires into /app when a bundle is configured", () => {
  const go = (path: string, init: RequestInit = {}) =>
    fetch(`${withWeb.url}${path}`, { redirect: "manual", ...init });

  it("sends the old front door to the dashboard", async () => {
    const r = await go("/");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/app/");
  });

  it("maps each console route onto its React equivalent", async () => {
    const cases: Array<[string, string]> = [
      ["/ui/jobs", "/app/folders"],
      ["/ui/jobs/new", "/app/folders/new"],
      ["/ui/jobs/media-photos", "/app/folders/media-photos"],
      // plan/apply/state all live on the React detail page now.
      ["/ui/jobs/media-photos/state", "/app/folders/media-photos"],
      // No equivalent page — the dashboard root is the honest landing spot.
      ["/ui/login", "/app/"],
      ["/ui/frag/host-row", "/app/"],
      ["/ui", "/app/"],
    ];
    for (const [from, to] of cases) {
      const r = await go(from);
      expect(r.status, from).toBe(302);
      expect(r.headers.get("location"), from).toBe(to);
    }
  });

  // A job name reaches the redirect straight from the URL; anything NAME_RE
  // rejects must not reach a Location header.
  it("refuses to reflect a name that could not have been created", async () => {
    for (const bad of ["/ui/jobs/Bad_Name", "/ui/jobs/bad%0aname", "/ui/jobs/..%2Fetc"]) {
      const r = await go(bad);
      expect(r.status, bad).toBe(302);
      expect(r.headers.get("location"), bad).toBe("/app/");
    }
  });

  // A stale tab still has the old form open; 303 makes the browser re-issue as
  // a GET instead of replaying the body somewhere that cannot read it.
  it("turns a POST from a stale tab into a GET", async () => {
    const r = await go("/ui/jobs", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "name=whatever",
    });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/app/");
  });

  it("leaves the console mounted when there is no bundle to redirect to", async () => {
    const login = await fetch(`${withoutWeb.url}/ui/login`, { redirect: "manual" });
    expect(login.status).toBe(200);
    expect(login.headers.get("content-type")).toContain("html");
    const root = await fetch(`${withoutWeb.url}/`, { redirect: "manual" });
    expect(root.headers.get("location")).toBe("/ui/jobs");
  });
});
