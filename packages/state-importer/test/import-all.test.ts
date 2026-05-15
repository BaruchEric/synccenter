import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { importAll } from "../src/import-all.ts";
import type { HostInfo } from "../src/types.ts";

function fakeFetch(map: Record<string, unknown>): typeof fetch {
  // Match by path-segment suffix to disambiguate `/rest/config/folders` (listFolders)
  // from `/rest/config/folders/test` (getFolder). For query-string endpoints
  // we fall back to substring matching.
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  return (async (input: Request | string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = url.split("?")[0] ?? url;
    for (const k of keys) {
      if (k.includes("?") || k.includes("=")) {
        if (url.includes(k)) return respond(map[k]);
        continue;
      }
      if (path.endsWith(k) || url.includes(k + "?")) return respond(map[k]);
    }
    // Fallback: substring includes for anything not anchored at the end.
    for (const k of keys) {
      if (url.includes(k)) return respond(map[k]);
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  function respond(body: unknown): Response {
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": typeof body === "string" ? "text/plain" : "application/json" },
    });
  }
}

describe("importAll", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "si-all-"));
    mkdirSync(join(dir, "folders"), { recursive: true });
    mkdirSync(join(dir, "hosts"), { recursive: true });
    mkdirSync(join(dir, "compiled/base-binaries"), { recursive: true });
    writeFileSync(join(dir, "compiled/base-binaries/.stignore"), ".DS_Store\nThumbs.db\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("imports every folder that's present on any host plus every declared host", async () => {
    const hosts: HostInfo[] = [
      { name: "mac-studio", apiUrl: "http://mac:8384", apiKey: "k1" },
      { name: "qnap-ts453d", apiUrl: "http://qnap:8384", apiKey: "k2" },
    ];
    // Pre-existing host YAML so importHost has shell data.
    writeFileSync(
      join(dir, "hosts/mac-studio.yaml"),
      "name: mac-studio\nhostname: mac.local\nos: macos\nsyncthing:\n  install_method: brew\n  api_url: http://mac:8384\n  api_key_ref: secrets/syncthing-api-keys.enc.yaml#mac-studio\n  device_id_ref: secrets/syncthing-device-ids.enc.yaml#mac-studio\n",
    );
    writeFileSync(
      join(dir, "hosts/qnap-ts453d.yaml"),
      "name: qnap-ts453d\nhostname: qnap.local\nos: qnap\nsyncthing:\n  install_method: docker\n  api_url: http://qnap:8384\n  api_key_ref: secrets/syncthing-api-keys.enc.yaml#qnap-ts453d\n  device_id_ref: secrets/syncthing-device-ids.enc.yaml#qnap-ts453d\n",
    );

    const fetchImpl = fakeFetch({
      "mac:8384/rest/config/folders": [
        { id: "test", label: "test", path: "/Users/eric/Sync/test", type: "sendreceive" },
      ],
      "qnap:8384/rest/config/folders": [
        { id: "test", label: "test", path: "/share/Sync/test", type: "sendreceive" },
      ],
      "/rest/config/folders/test": { id: "test", label: "test", path: "/p", type: "sendreceive" },
      "/rest/db/ignores": { ignore: [".DS_Store", "Thumbs.db"], expanded: [".DS_Store", "Thumbs.db"] },
      "mac:8384/rest/system/status": { myID: "AAA" },
      "qnap:8384/rest/system/status": { myID: "BBB" },
    });

    const results = await importAll({ configDir: dir, hosts, write: true, fetch: fetchImpl });
    const folderResults = results.filter((r) => r.resource.kind === "folder");
    const hostResults = results.filter((r) => r.resource.kind === "host");
    expect(folderResults.map((r) => r.resource.name)).toContain("test");
    expect(hostResults.map((r) => r.resource.name).sort()).toEqual(["mac-studio", "qnap-ts453d"]);
  });
});
