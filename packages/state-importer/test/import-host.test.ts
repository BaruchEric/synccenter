import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { importHost } from "../src/import-host.ts";

function fakeFetch(map: Record<string, unknown>): typeof fetch {
  return (async (input: Request | string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const k of Object.keys(map)) {
      if (url.includes(k)) {
        return new Response(JSON.stringify(map[k]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("importHost", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "si-host-"));
    mkdirSync(join(dir, "hosts"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads /rest/system/status and emits canonical YAML on first run", async () => {
    const fetchImpl = fakeFetch({
      "/rest/system/status": { myID: "AAAA-BBBB-CCCC", platform: "darwin" },
      "/rest/system/version": { version: "v2.1.0" },
    });
    const onDiskHost = {
      name: "mac-studio",
      hostname: "mac.local",
      os: "macos" as const,
      apiUrl: "http://mac:8384",
      apiKey: "key",
    };
    const res = await importHost(onDiskHost, { configDir: dir, hosts: [], write: true, fetch: fetchImpl });
    expect(res.status).toBe("written");
    const written = readFileSync(join(dir, "hosts/mac-studio.yaml"), "utf8");
    expect(written).toContain("name: mac-studio");
    expect(written).toContain("os: macos");
    expect(written).toContain("api_url: http://mac:8384");
  });

  it("reports 'identical' on second run with same live state", async () => {
    const fetchImpl = fakeFetch({
      "/rest/system/status": { myID: "AAAA-BBBB-CCCC", platform: "darwin" },
      "/rest/system/version": { version: "v2.1.0" },
    });
    const onDiskHost = {
      name: "mac-studio", hostname: "mac.local", os: "macos" as const, apiUrl: "http://mac:8384", apiKey: "key",
    };
    await importHost(onDiskHost, { configDir: dir, hosts: [], write: true, fetch: fetchImpl });
    const second = await importHost(onDiskHost, { configDir: dir, hosts: [], write: false, fetch: fetchImpl });
    expect(second.status).toBe("identical");
  });
});
