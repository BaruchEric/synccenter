import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RcloneClient, SyncthingClient } from "@synccenter/adapters";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { HostRegistry } from "../src/registry.ts";

const TOKEN = "ui-test-token-of-sufficient-length-123456";

class FakeSyncthing {
  async browse(current: string) {
    if (current.startsWith("/share")) return ["/share/Sync/", "/share/Photos/"];
    return ["/Users/eric/", "/Users/shared/"];
  }
  async getFolderStatus(_id: string) {
    return {
      state: "idle" as const,
      globalBytes: 10,
      globalFiles: 1,
      localBytes: 10,
      localFiles: 1,
      needBytes: 0,
      needFiles: 0,
      errors: 0,
      pullErrors: 0,
      sequence: 1,
      stateChanged: "2026-07-16T00:00:00Z",
    };
  }
}

let tmpRoot: string;
let configDir: string;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "synccenter-ui-"));
  configDir = join(tmpRoot, "synccenter-config");
  for (const sub of ["rules", "folders", "hosts", "imports", "compiled"]) {
    mkdirSync(join(configDir, sub), { recursive: true });
  }
  writeFileSync(
    join(configDir, "rules", "base-binaries.yaml"),
    "name: base-binaries\nversion: 1\nexcludes:\n  - .DS_Store\n",
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
  for (const [host, os, role] of [
    ["mac-studio", "macos", "mesh-node"],
    ["qnap-ts453d", "qnap", "cloud-edge"],
  ] as const) {
    writeFileSync(
      join(configDir, "hosts", `${host}.yaml`),
      [
        `name: ${host}`,
        `hostname: ${host}.local`,
        `os: ${os}`,
        `role: ${role}`,
        "syncthing:",
        "  install_method: docker",
        "  api_url: http://127.0.0.1:1",
        `  api_key_ref: secrets/x.enc.yaml#${host}`,
        `  device_id_ref: secrets/y.enc.yaml#${host}`,
      ].join("\n"),
    );
  }
  writeFileSync(
    join(configDir, "hosts", "gdrive.yaml"),
    ["name: gdrive", "engine: rclone", "remote: gdrive"].join("\n"),
  );

  const cfg = loadConfig({
    SC_CONFIG_DIR: configDir,
    SC_API_TOKEN: TOKEN,
    PORT: "0",
    SC_DB_PATH: ":memory:",
  });
  const clients = new Map<string, SyncthingClient>();
  clients.set("mac-studio", new FakeSyncthing() as unknown as SyncthingClient);
  clients.set("qnap-ts453d", new FakeSyncthing() as unknown as SyncthingClient);
  const registry = new HostRegistry({ cfg, clients });
  const fakeRclone = {
    async listRemotes() {
      return { remotes: ["gdrive", "b2"] };
    },
    async listDirs(_fs: string, remote: string) {
      if (remote === "") {
        return {
          list: [
            { Path: "sync", Name: "sync", IsDir: true },
            { Path: "backup", Name: "backup", IsDir: true },
          ],
        };
      }
      return {
        list: [
          { Path: `${remote}/media`, Name: "media", IsDir: true },
          { Path: `${remote}/docs`, Name: "docs", IsDir: true },
        ],
      };
    },
  };
  const { app } = buildApp({ cfg, registry, rclone: fakeRclone as unknown as RcloneClient });

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

function ui(path: string, init: RequestInit = {}, withSession = true): Promise<Response> {
  const headers = new Headers(init.headers);
  if (withSession) headers.set("cookie", `sc_auth=${TOKEN}`);
  return fetch(`${baseUrl}${path}`, { redirect: "manual", ...init, headers });
}

function form(fields: Array<[string, string]>): RequestInit {
  const body = new URLSearchParams();
  for (const [k, v] of fields) body.append(k, v);
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  };
}

function withName(fields: Array<[string, string]>, name: string): Array<[string, string]> {
  return fields.map(([k, v]) => (k === "name" ? [k, name] : [k, v]));
}

const VALID_JOB: Array<[string, string]> = [
  ["name", "media-photos"],
  ["ruleset", "base-binaries"],
  ["type", "send-receive"],
  ["host", "mac-studio"],
  ["path", "/Users/eric/Photos"],
  ["htype", ""],
  ["host", "qnap-ts453d"],
  ["path", "/share/Photos"],
  ["htype", "receive-only"],
];

describe("session auth", () => {
  it("GET /ui/login renders without a session", async () => {
    const r = await ui("/ui/login", {}, false);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain("API token");
    expect(body).toContain('action="/ui/login"');
  });

  it("POST /ui/login with a wrong token is rejected", async () => {
    const r = await ui("/ui/login", form([["token", "wrong"]]), false);
    expect(r.status).toBe(401);
    expect(await r.text()).toContain("Token doesn&#39;t match");
  });

  it("POST /ui/login with the right token sets the session cookie", async () => {
    const r = await ui("/ui/login", form([["token", TOKEN]]), false);
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/ui/jobs");
    const cookie = r.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`sc_auth=${TOKEN}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("redirects unauthenticated page loads to /ui/login", async () => {
    const r = await ui("/ui/jobs", {}, false);
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/ui/login");
  });

  it("answers unauthenticated HTMX requests with HX-Redirect", async () => {
    const r = await ui("/ui/jobs", { headers: { "HX-Request": "true" } }, false);
    expect(r.status).toBe(401);
    expect(r.headers.get("hx-redirect")).toBe("/ui/login");
  });

  it("serves htmx without auth", async () => {
    const r = await ui("/ui/assets/htmx.min.js", {}, false);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("htmx");
  });

  it("redirects / to the console", async () => {
    const r = await ui("/", {}, false);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/ui/jobs");
  });
});

describe("jobs list + new form", () => {
  it("lists existing sync jobs", async () => {
    const r = await ui("/ui/jobs");
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain("shared");
    expect(body).toContain("New sync job");
  });

  it("renders the creation form with rules and hosts", async () => {
    const r = await ui("/ui/jobs/new");
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain('id="job-form"');
    expect(body).toContain('value="base-binaries"');
    expect(body).toContain('value="mac-studio"');
    expect(body).toContain("paths:");
    expect(body).toContain("/ui/frag/preview");
  });

  it("serves an extra host row fragment", async () => {
    const r = await ui("/ui/frag/host-row");
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain('name="host"');
    expect(body).toContain('name="path"');
  });
});

describe("name validation fragment", () => {
  it("flags taken names", async () => {
    const r = await ui("/ui/frag/validate-name", form([["name", "shared"]]));
    expect(await r.text()).toContain("already exists");
  });

  it("flags invalid names", async () => {
    const r = await ui("/ui/frag/validate-name", form([["name", "Bad_Name"]]));
    expect(await r.text()).toContain("lowercase");
  });

  it("accepts free names", async () => {
    const r = await ui("/ui/frag/validate-name", form([["name", "fresh-name"]]));
    expect(await r.text()).toContain("will write folders/fresh-name.yaml");
  });
});

describe("live preview fragments", () => {
  it("renders the manifest YAML for a valid form", async () => {
    const r = await ui("/ui/frag/preview", form(withName(VALID_JOB, "previewed")));
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain("folders/previewed.yaml");
    expect(body).toContain("previewed");
    expect(body).toContain("mac-studio");
    expect(body).toContain("receive-only");
  });

  it("lists blocking errors for duplicate hosts", async () => {
    const dup: Array<[string, string]> = [
      ["name", "dup-host"],
      ["ruleset", "base-binaries"],
      ["type", "send-receive"],
      ["host", "mac-studio"],
      ["path", "/a"],
      ["host", "mac-studio"],
      ["path", "/b"],
    ];
    const body = await (await ui("/ui/frag/preview", form(dup))).text();
    expect(body).toContain("appears twice");
  });

  it("rejects a non-numeric watcher delay", async () => {
    const body = await (
      await ui("/ui/frag/preview", form([...withName(VALID_JOB, "delay-check"), ["fs_watcher_delay_s", "soon"]]))
    ).text();
    expect(body).toContain("whole number of seconds");
  });

  it("warns about relative paths without blocking", async () => {
    const rel: Array<[string, string]> = [
      ["name", "rel-path"],
      ["ruleset", "base-binaries"],
      ["type", "send-receive"],
      ["host", "mac-studio"],
      ["path", "relative/dir"],
    ];
    const body = await (await ui("/ui/frag/preview", form(rel))).text();
    expect(body).toContain("not absolute");
    expect(body).not.toContain("Fix before creating");
  });

  it("plan preview degrades gracefully when secrets can't resolve", async () => {
    const r = await ui("/ui/frag/preview-plan", form(withName(VALID_JOB, "planned")));
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("Plan unavailable");
  });

  it("plan preview refuses an invalid form", async () => {
    const r = await ui("/ui/frag/preview-plan", form([["name", "x-no-paths"], ["ruleset", "base-binaries"]]));
    expect(r.status).toBe(422);
    expect(await r.text()).toContain("Fix the form before planning");
  });
});

describe("pickers", () => {
  it("suggests directories on a host via Syncthing browse", async () => {
    const r = await ui("/ui/frag/browse-host?host=qnap-ts453d&path=%2Fshare%2F&pdl=pdl-abc");
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain('id="pdl-abc"');
    expect(body).toContain('value="/share/Sync/"');
    expect(body).toContain('value="/share/Photos/"');
  });

  it("returns an empty datalist for unknown hosts", async () => {
    const body = await (await ui("/ui/frag/browse-host?host=nope&path=%2F&pdl=pdl-x")).text();
    expect(body).toContain('id="pdl-x"');
    expect(body).not.toContain("option");
  });

  it("rejects malformed datalist ids", async () => {
    const r = await ui('/ui/frag/browse-host?host=mac-studio&path=%2F&pdl=bad"id');
    expect(r.status).toBe(400);
  });

  it("browses inside the remote for rclone members", async () => {
    const body = await (await ui("/ui/frag/browse-host?host=gdrive&path=&pdl=pdl-0")).text();
    expect(body).toContain('value="sync"');
    expect(body).toContain('value="backup"');
  });

  it("completes remote paths, filtering on the typed fragment", async () => {
    const body = await (await ui("/ui/frag/browse-host?host=gdrive&path=sync%2Fme&pdl=pdl-0")).text();
    expect(body).toContain('value="sync/media"');
    expect(body).not.toContain("docs");
  });

  it("describes common cron shapes", async () => {
    const cases: Array<[string, string]> = [
      ["*/30 * * * *", "every 30 minutes"],
      ["0 2 * * *", "daily at 02:00"],
      ["0 3 * * 0", "Sun at 03:00"],
      ["15 */6 * * *", "every 6 hours at :15"],
    ];
    for (const [expr, expected] of cases) {
      const body = await (await ui("/ui/frag/cron-hint", form([["bisync_schedule", expr]]))).text();
      expect(body).toContain(expected);
    }
  });

  it("flags invalid cron expressions", async () => {
    const body = await (await ui("/ui/frag/cron-hint", form([["bisync_schedule", "99 * * * *"]]))).text();
    expect(body).toContain("minute");
    expect(body).toContain("bad");
  });
});

describe("create sync job (UI)", () => {
  it("writes the manifest and redirects to the job page", async () => {
    const r = await ui("/ui/jobs", form(VALID_JOB));
    expect(r.status).toBe(200);
    expect(r.headers.get("hx-redirect")).toBe("/ui/jobs/media-photos");
    expect(existsSync(join(configDir, "folders", "media-photos.yaml"))).toBe(true);

    const viaApi = await fetch(`${baseUrl}/folders/media-photos`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const manifest = (await viaApi.json()) as {
      type: string;
      paths: Record<string, string>;
      overrides?: Record<string, { type: string }>;
    };
    expect(manifest.paths["qnap-ts453d"]).toBe("/share/Photos");
    expect(manifest.overrides?.["qnap-ts453d"]?.type).toBe("receive-only");
  });

  it("refuses a duplicate name with 409", async () => {
    const r = await ui("/ui/jobs", form(VALID_JOB));
    expect(r.status).toBe(409);
    expect(await r.text()).toContain("already exists");
  });

  it("refuses a form without any host paths", async () => {
    const r = await ui("/ui/jobs", form([["name", "empty-job"], ["ruleset", "base-binaries"]]));
    expect(r.status).toBe(422);
    expect(await r.text()).toContain("at least one host");
    expect(existsSync(join(configDir, "folders", "empty-job.yaml"))).toBe(false);
  });
});

describe("job detail", () => {
  it("shows the manifest YAML, plan and apply controls", async () => {
    const r = await ui("/ui/jobs/media-photos");
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain("folders/media-photos.yaml");
    expect(body).toContain("Preview plan");
    expect(body).toContain("Apply to 2 hosts");
    expect(body).toContain("Arm real apply");
  });

  it("404s for unknown jobs", async () => {
    const r = await ui("/ui/jobs/never-made");
    expect(r.status).toBe(404);
    expect(await r.text()).toContain("No sync job named");
  });

  it("reports per-host folder state", async () => {
    const r = await ui("/ui/jobs/shared/state");
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain("mac-studio");
    expect(body).toContain("idle");
  });

  it("refuses a real apply that isn't armed", async () => {
    const r = await ui("/ui/jobs/shared/apply", form([["prune", "on"]]));
    expect(r.status).toBe(422);
    expect(await r.text()).toContain("Arm real apply");
  });
});

describe("JSON create endpoint", () => {
  function post(body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/folders`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("creates a folder manifest from JSON", async () => {
    const r = await post({
      name: "json-made",
      ruleset: "base-binaries",
      type: "send-receive",
      paths: { "mac-studio": "/Users/eric/JsonMade" },
    });
    expect(r.status).toBe(201);
    const out = (await r.json()) as { path: string };
    expect(out.path).toBe("folders/json-made.yaml");
    expect(existsSync(join(configDir, "folders", "json-made.yaml"))).toBe(true);
  });

  it("409s on duplicates", async () => {
    const r = await post({
      name: "json-made",
      ruleset: "base-binaries",
      type: "send-receive",
      paths: { "mac-studio": "/x" },
    });
    expect(r.status).toBe(409);
    const out = (await r.json()) as { error: { code: string } };
    expect(out.error.code).toBe("NAME_TAKEN");
  });

  it("400s on schema violations", async () => {
    const r = await post({ name: "no-ruleset", type: "send-receive", paths: { "mac-studio": "/x" } });
    expect(r.status).toBe(400);
    const out = (await r.json()) as { error: { code: string } };
    expect(out.error.code).toBe("SCHEMA_INVALID");
  });

  it("400s on unknown hosts", async () => {
    const r = await post({
      name: "ghost-host",
      ruleset: "base-binaries",
      type: "send-receive",
      paths: { "not-a-host": "/x" },
    });
    expect(r.status).toBe(400);
    const out = (await r.json()) as { error: { code: string; message: string } };
    expect(out.error.code).toBe("UNKNOWN_HOST");
    expect(out.error.message).toContain("known hosts");
  });
});
