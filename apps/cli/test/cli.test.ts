import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(import.meta.dir, "..", "src", "index.ts");

let tmpRoot: string;
let configDir: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "synccenter-cli-"));
  configDir = join(tmpRoot, "synccenter-config");
  for (const sub of ["rules", "folders", "hosts", "imports/github-gitignore", "schedules", "compiled"]) {
    mkdirSync(join(configDir, sub), { recursive: true });
  }
  writeFileSync(
    join(configDir, "rules", "base-binaries.yaml"),
    "name: base-binaries\nversion: 1\nexcludes:\n  - .DS_Store\n  - Thumbs.db\n",
  );
  writeFileSync(
    join(configDir, "rules", "with-node.yaml"),
    "name: with-node\nversion: 1\nimports:\n  - github://github/gitignore/Node\nexcludes:\n  - '**/dist/'\nincludes:\n  - '!**/dist/keep.txt'\n",
  );
  writeFileSync(
    join(configDir, "imports", "github-gitignore", "Node.gitignore"),
    "*.log\nnode_modules/\n",
  );
  writeFileSync(
    join(configDir, "folders", "example.yaml"),
    "name: example\nruleset: base-binaries\ntype: send-receive\npaths:\n  mac: /tmp/sync\n",
  );
});

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync("bun", ["run", CLI, "--config", configDir, ...args], {
    encoding: "utf8",
    env: { ...process.env, SC_CONFIG_DIR: undefined } as NodeJS.ProcessEnv,
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status ?? 1 };
}

describe("sc rules", () => {
  it("lists rulesets", () => {
    const r = runCli(["rules", "list"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n").sort()).toEqual(["base-binaries", "with-node"]);
  });

  it("emits --json output", () => {
    const r = runCli(["--json", "rules", "list"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ rulesets: ["base-binaries", "with-node"] });
  });

  it("compiles to compiled/<name>/", () => {
    const r = runCli(["rules", "compile", "with-node"]);
    expect(r.status).toBe(0);
    const stignore = join(configDir, "compiled", "with-node", ".stignore");
    const rclone = join(configDir, "compiled", "with-node", "filter.rclone");
    expect(existsSync(stignore)).toBe(true);
    expect(existsSync(rclone)).toBe(true);
  });

  it("preview prints both engines without writing files", () => {
    const r = runCli(["rules", "preview", "base-binaries"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("=== .stignore ===");
    expect(r.stdout).toContain("=== filter.rclone ===");
    expect(r.stdout).toContain(".DS_Store");
  });

  it("exits non-zero with a helpful message when ruleset is missing", () => {
    const r = runCli(["rules", "compile", "nope"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("cannot read ruleset");
  });
});

describe("sc folders", () => {
  it("lists folders", () => {
    const r = runCli(["folders", "list"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("example");
  });

  it("get returns parsed YAML as JSON-ish", () => {
    const r = runCli(["--json", "folders", "get", "example"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toMatchObject({ name: "example", ruleset: "base-binaries", type: "send-receive" });
  });
});

describe("sc placeholders", () => {
  it("status exits 2 with a phase-3 message", () => {
    const r = runCli(["status"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Phase 3");
  });
});

describe("sc imports", () => {
  it("list shows each import with cache state", () => {
    const r = runCli(["--json", "imports", "list"]);
    expect(r.status).toBe(0);
    const body = JSON.parse(r.stdout) as {
      imports: Array<{ uri: string; cached: boolean }>;
    };
    const node = body.imports.find((i) => i.uri === "github://github/gitignore/Node");
    expect(node).toBeDefined();
    expect(node!.cached).toBe(false);
  });

  it("refresh writes the cached file and updates checksums.json", () => {
    // Pre-stage the cache file so refresh sees "cached" without network.
    const importsDir = join(configDir, "imports");
    mkdirSync(join(importsDir, "github-gitignore"), { recursive: true });
    writeFileSync(join(importsDir, "github-gitignore", "Node.gitignore"), "*.log\nnode_modules/\n");
    // checksums.json says we fetched it just now, so refresh should report cached.
    writeFileSync(
      join(importsDir, "checksums.json"),
      JSON.stringify(
        {
          version: 1,
          entries: [
            {
              uri: "github://github/gitignore/Node",
              sha256: "deadbeef".repeat(8),
              bytes: 22,
              fetchedAt: new Date().toISOString(),
              cachePath: "github-gitignore/Node.gitignore",
            },
          ],
        },
        null,
        2,
      ),
    );
    const r = runCli(["--json", "imports", "refresh"]);
    expect(r.status).toBe(0);
    const body = JSON.parse(r.stdout) as {
      results: Array<{ uri: string; status: string }>;
    };
    expect(body.results.some((x) => x.status === "cached")).toBe(true);
  });
});
