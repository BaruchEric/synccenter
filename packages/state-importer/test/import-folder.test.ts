import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { importFolder } from "../src/import-folder.ts";
import type { HostInfo } from "../src/types.ts";

function fakeFetch(responses: Map<string, unknown>): typeof fetch {
  return (async (input: Request | string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [pattern, body] of responses) {
      if (url.includes(pattern)) {
        return new Response(typeof body === "string" ? body : JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": typeof body === "string" ? "text/plain" : "application/json" },
        });
      }
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("importFolder", () => {
  let dir: string;
  const hosts: HostInfo[] = [
    { name: "mac-studio", apiUrl: "http://mac:8384", apiKey: "k1" },
    { name: "qnap-ts453d", apiUrl: "http://qnap:8384", apiKey: "k2" },
  ];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "si-folder-"));
    mkdirSync(join(dir, "folders"), { recursive: true });
    mkdirSync(join(dir, "compiled/base-binaries"), { recursive: true });
    writeFileSync(
      join(dir, "compiled/base-binaries/.stignore"),
      "# header\n.DS_Store\nThumbs.db\n*.tmp\n",
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("emits canonical folder YAML and reports 'written' on first run", async () => {
    const fetchImpl = fakeFetch(new Map<string, unknown>([
      ["mac:8384/rest/config/folders/test", { id: "test", label: "test", path: "/Users/eric/Sync/test", type: "sendreceive" }],
      ["qnap:8384/rest/config/folders/test", { id: "test", label: "test", path: "/share/Sync/test", type: "sendreceive" }],
      ["rest/db/ignores", { ignore: [".DS_Store", "Thumbs.db", "*.tmp"], expanded: [".DS_Store", "Thumbs.db", "*.tmp"] }],
    ]));

    const res = await importFolder("test", { configDir: dir, hosts, write: true, fetch: fetchImpl });
    expect(res.status).toBe("written");
    expect(existsSync(join(dir, "folders/test.yaml"))).toBe(true);

    const written = readFileSync(join(dir, "folders/test.yaml"), "utf8");
    expect(written).toContain("name: test");
    expect(written).toContain("ruleset: base-binaries");
    expect(written).toContain("type: send-receive");
    expect(written).toContain("mac-studio: /Users/eric/Sync/test");
    expect(written).toContain("qnap-ts453d: /share/Sync/test");
  });

  it("reports 'identical' on second run", async () => {
    const fetchImpl = fakeFetch(new Map<string, unknown>([
      ["mac:8384/rest/config/folders/test", { id: "test", label: "test", path: "/Users/eric/Sync/test", type: "sendreceive" }],
      ["qnap:8384/rest/config/folders/test", { id: "test", label: "test", path: "/share/Sync/test", type: "sendreceive" }],
      ["rest/db/ignores", { ignore: [".DS_Store", "Thumbs.db", "*.tmp"], expanded: [".DS_Store", "Thumbs.db", "*.tmp"] }],
    ]));
    await importFolder("test", { configDir: dir, hosts, write: true, fetch: fetchImpl });
    const second = await importFolder("test", { configDir: dir, hosts, write: false, fetch: fetchImpl });
    expect(second.status).toBe("identical");
  });

  it("reports 'would-change' with a diff when content differs and write is false", async () => {
    writeFileSync(
      join(dir, "folders/test.yaml"),
      "name: test\nruleset: base-binaries\ntype: send-receive\npaths:\n  mac-studio: /WRONG\n",
    );
    const fetchImpl = fakeFetch(new Map<string, unknown>([
      ["mac:8384/rest/config/folders/test", { id: "test", label: "test", path: "/Users/eric/Sync/test", type: "sendreceive" }],
      ["qnap:8384/rest/config/folders/test", { id: "test", label: "test", path: "/share/Sync/test", type: "sendreceive" }],
      ["rest/db/ignores", { ignore: [".DS_Store", "Thumbs.db", "*.tmp"], expanded: [".DS_Store", "Thumbs.db", "*.tmp"] }],
    ]));
    const res = await importFolder("test", { configDir: dir, hosts, write: false, fetch: fetchImpl });
    expect(res.status).toBe("would-change");
    expect(res.diff).toContain("/WRONG");
    expect(res.diff).toContain("/Users/eric/Sync/test");
  });

  it("throws FOLDER_NOT_PRESENT_ANYWHERE when no host has the folder", async () => {
    const fetchImpl = fakeFetch(new Map());
    await expect(
      importFolder("ghost", { configDir: dir, hosts, fetch: fetchImpl }),
    ).rejects.toMatchObject({ code: "FOLDER_NOT_PRESENT_ANYWHERE" });
  });
});
