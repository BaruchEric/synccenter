import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ImporterError,
  parseImportUri,
  refreshAll,
  refreshOne,
  scanRulesetImports,
  loadChecksums,
  isHostAllowed,
  loadAllowlist,
} from "../src/index.ts";

describe("parseImportUri", () => {
  it("recognizes github://github/gitignore/<NAME>", () => {
    expect(parseImportUri("github://github/gitignore/Node")).toEqual({
      uri: "github://github/gitignore/Node",
      scheme: "github",
      githubName: "Node",
    });
  });

  it("recognizes file://<path>", () => {
    expect(parseImportUri("file://./local.txt").scheme).toBe("file");
  });

  it("recognizes ruleset://<name>", () => {
    expect(parseImportUri("ruleset://base-binaries").rulesetName).toBe("base-binaries");
  });

  it("recognizes url://<https-url>", () => {
    expect(parseImportUri("url://https://example.com/x.txt").url).toBe("https://example.com/x.txt");
  });

  it("rejects http:// in url://", () => {
    expect(() => parseImportUri("url://http://example.com/x.txt")).toThrow(ImporterError);
  });

  it("rejects unknown schemes", () => {
    expect(() => parseImportUri("ftp://foo")).toThrow(ImporterError);
  });
});

describe("allowlist", () => {
  it("ships raw.githubusercontent.com by default", () => {
    expect(isHostAllowed("raw.githubusercontent.com", loadAllowlist("/nonexistent"))).toBe(true);
  });

  it("rejects hosts not in the list", () => {
    expect(isHostAllowed("evil.example.com", loadAllowlist("/nonexistent"))).toBe(false);
  });

  it("merges in extras from allowlist.txt", () => {
    const dir = mkdtempSync(join(tmpdir(), "synccenter-allow-"));
    writeFileSync(join(dir, "allowlist.txt"), "# comment\nextra.example.com\n\nanother.example.com\n");
    expect(loadAllowlist(dir)).toContain("extra.example.com");
    expect(loadAllowlist(dir)).toContain("another.example.com");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("scanRulesetImports", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "synccenter-scan-"));
    writeFileSync(
      join(dir, "a.yaml"),
      "name: a\nversion: 1\nimports:\n  - github://github/gitignore/Node\n  - ruleset://base\n",
    );
    writeFileSync(
      join(dir, "b.yaml"),
      "name: b\nversion: 1\nimports:\n  - github://github/gitignore/Python\n  - github://github/gitignore/Node\n",
    );
    writeFileSync(join(dir, "leaf.yaml"), "name: leaf\nversion: 1\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("dedupes and sorts across rulesets", () => {
    const r = scanRulesetImports(dir);
    expect(r.imports).toEqual([
      "github://github/gitignore/Node",
      "github://github/gitignore/Python",
      "ruleset://base",
    ]);
    expect(r.perRuleset.a).toEqual(["github://github/gitignore/Node", "ruleset://base"]);
    expect(r.perRuleset.leaf).toBeUndefined();
  });
});

describe("refreshOne — github", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "synccenter-fetch-"));
    mkdirSync(join(dir, "imports"), { recursive: true });
    mkdirSync(join(dir, "rules"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function fakeFetch(body: string, status = 200): typeof fetch {
    return (async () =>
      new Response(body, { status, statusText: "OK" })) as unknown as typeof fetch;
  }

  it("fetches and caches a github gitignore, writes checksums.json", async () => {
    const r = await refreshOne("github://github/gitignore/Node", {
      importsDir: join(dir, "imports"),
      rulesetsDir: join(dir, "rules"),
      fetch: fakeFetch("*.log\nnode_modules/\n"),
      now: new Date("2026-05-14T10:00:00Z"),
    });
    expect(r.status).toBe("fetched");
    expect(r.cachePath).toBe("github-gitignore/Node.gitignore");
    expect(existsSync(join(dir, "imports", r.cachePath!))).toBe(true);
    expect(readFileSync(join(dir, "imports", r.cachePath!), "utf8")).toContain("*.log");

    const checks = loadChecksums(join(dir, "imports"));
    expect(checks.entries.length).toBe(1);
    expect(checks.entries[0]!.uri).toBe("github://github/gitignore/Node");
    expect(checks.entries[0]!.sha256).toHaveLength(64);
  });

  it("returns 'cached' when entry is fresh and file present", async () => {
    const opts = {
      importsDir: join(dir, "imports"),
      rulesetsDir: join(dir, "rules"),
      now: new Date("2026-05-14T10:00:00Z"),
    };
    await refreshOne("github://github/gitignore/Node", { ...opts, fetch: fakeFetch("v1\n") });
    let fetchCount = 0;
    const second = await refreshOne("github://github/gitignore/Node", {
      ...opts,
      fetch: (async () => {
        fetchCount++;
        return new Response("v2\n", { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(second.status).toBe("cached");
    expect(fetchCount).toBe(0);
  });

  it("re-fetches when force=true even if recent", async () => {
    const baseOpts = {
      importsDir: join(dir, "imports"),
      rulesetsDir: join(dir, "rules"),
      now: new Date("2026-05-14T10:00:00Z"),
    };
    await refreshOne("github://github/gitignore/Node", { ...baseOpts, fetch: fakeFetch("v1\n") });
    const second = await refreshOne("github://github/gitignore/Node", {
      ...baseOpts,
      fetch: fakeFetch("v2-NEW\n"),
      force: true,
    });
    expect(second.status).toBe("fetched");
    expect(readFileSync(join(dir, "imports", "github-gitignore", "Node.gitignore"), "utf8")).toContain("v2-NEW");
  });

  it("re-fetches when entry is older than maxAgeMs", async () => {
    const old = new Date("2026-05-01T00:00:00Z");
    const now = new Date("2026-05-14T00:00:00Z"); // 13 days later
    await refreshOne("github://github/gitignore/Node", {
      importsDir: join(dir, "imports"),
      rulesetsDir: join(dir, "rules"),
      now: old,
      fetch: fakeFetch("old\n"),
    });
    const r2 = await refreshOne("github://github/gitignore/Node", {
      importsDir: join(dir, "imports"),
      rulesetsDir: join(dir, "rules"),
      now,
      fetch: fakeFetch("new\n"),
    });
    expect(r2.status).toBe("fetched");
  });

  it("returns error-fetch on non-2xx", async () => {
    const r = await refreshOne("github://github/gitignore/Nope", {
      importsDir: join(dir, "imports"),
      rulesetsDir: join(dir, "rules"),
      fetch: (async () => new Response("not found", { status: 404, statusText: "Not Found" })) as unknown as typeof fetch,
    });
    expect(r.status).toBe("error-fetch");
    expect(r.error).toContain("404");
  });
});

describe("refreshOne — url + file + ruleset", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "synccenter-misc-"));
    mkdirSync(join(dir, "imports"), { recursive: true });
    mkdirSync(join(dir, "rules"), { recursive: true });
    writeFileSync(join(dir, "rules", "base.yaml"), "name: base\nversion: 1\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("url:// honors the allowlist", async () => {
    const blocked = await refreshOne("url://https://evil.example.com/x.txt", {
      importsDir: join(dir, "imports"),
      rulesetsDir: join(dir, "rules"),
      fetch: (async () => new Response("nope", { status: 200 })) as unknown as typeof fetch,
    });
    expect(blocked.status).toBe("error-allowlist");

    const allowed = await refreshOne("url://https://ok.example.com/x.txt", {
      importsDir: join(dir, "imports"),
      rulesetsDir: join(dir, "rules"),
      allowlist: ["raw.githubusercontent.com", "ok.example.com"],
      fetch: (async () => new Response("ok\n", { status: 200 })) as unknown as typeof fetch,
    });
    expect(allowed.status).toBe("fetched");
    expect(allowed.cachePath!).toContain("url-cache/");
  });

  it("ruleset:// is skipped-not-cacheable when target exists", async () => {
    const r = await refreshOne("ruleset://base", {
      importsDir: join(dir, "imports"),
      rulesetsDir: join(dir, "rules"),
    });
    expect(r.status).toBe("skipped-not-cacheable");
  });

  it("ruleset:// is skipped-missing-local when target is absent", async () => {
    const r = await refreshOne("ruleset://nope", {
      importsDir: join(dir, "imports"),
      rulesetsDir: join(dir, "rules"),
    });
    expect(r.status).toBe("skipped-missing-local");
  });

  it("file:// flags missing files", async () => {
    const r = await refreshOne("file:///nonexistent/path.txt", {
      importsDir: join(dir, "imports"),
      rulesetsDir: join(dir, "rules"),
    });
    expect(r.status).toBe("skipped-missing-local");
  });
});

describe("refreshAll", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "synccenter-refall-"));
    mkdirSync(join(dir, "imports"), { recursive: true });
    mkdirSync(join(dir, "rules"), { recursive: true });
    writeFileSync(
      join(dir, "rules", "a.yaml"),
      "name: a\nversion: 1\nimports:\n  - github://github/gitignore/Node\n  - github://github/gitignore/Python\n",
    );
    writeFileSync(join(dir, "rules", "base.yaml"), "name: base\nversion: 1\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("processes every unique import once", async () => {
    const seen: string[] = [];
    const fakeFetch = (async (input: Request | string | URL) => {
      seen.push(typeof input === "string" ? input : input.toString());
      return new Response("# fixture\n", { status: 200 });
    }) as unknown as typeof fetch;

    const results = await refreshAll({
      importsDir: join(dir, "imports"),
      rulesetsDir: join(dir, "rules"),
      fetch: fakeFetch,
      now: new Date("2026-05-14T00:00:00Z"),
    });
    expect(results.map((r) => r.uri).sort()).toEqual([
      "github://github/gitignore/Node",
      "github://github/gitignore/Python",
    ]);
    expect(results.every((r) => r.status === "fetched")).toBe(true);
    expect(seen.length).toBe(2);
  });

  it("preserves every checksum entry — no parallel-write race", async () => {
    const fakeFetch = (async () => new Response("data\n", { status: 200 })) as unknown as typeof fetch;
    await refreshAll({
      importsDir: join(dir, "imports"),
      rulesetsDir: join(dir, "rules"),
      fetch: fakeFetch,
      now: new Date("2026-05-14T00:00:00Z"),
    });
    const checks = loadChecksums(join(dir, "imports"));
    const uris = checks.entries.map((e) => e.uri).sort();
    expect(uris).toEqual([
      "github://github/gitignore/Node",
      "github://github/gitignore/Python",
    ]);
  });
});
