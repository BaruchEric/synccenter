import { describe, it, expect } from "bun:test";
import { join } from "path";
import { loadFolderManifest, loadAllHosts } from "../src/load.ts";

const FIX = join(import.meta.dir, "fixtures");

describe("loadFolderManifest", () => {
  it("loads test.yaml and validates against the folder schema", () => {
    const f = loadFolderManifest(join(FIX, "folders/test.yaml"));
    expect(f.name).toBe("test");
    expect(f.type).toBeDefined();
    expect(f.paths).toBeDefined();
  });

  it("loads example-code-projects.yaml with cloud + bisync", () => {
    const f = loadFolderManifest(join(FIX, "folders/example-code-projects.yaml"));
    expect(f.name).toBe("example-code-projects");
    expect(f.cloud?.rclone_remote).toBe("gdrive");
    expect(f.cloud?.bisync?.schedule).toBe("*/15 * * * *");
  });

  it("throws PlanError(MANIFEST_NOT_FOUND) when the file doesn't exist", () => {
    expect(() => loadFolderManifest(join(FIX, "folders/nope.yaml"))).toThrow(/MANIFEST_NOT_FOUND/);
  });

  it("throws PlanError(SCHEMA_INVALID) when a required field is missing", () => {
    const { writeFileSync, mkdtempSync, rmSync } = require("fs");
    const { tmpdir } = require("os");
    const tmp = mkdtempSync(join(tmpdir(), "ap-"));
    const p = join(tmp, "bad.yaml");
    writeFileSync(p, "name: bad\n");
    try {
      expect(() => loadFolderManifest(p)).toThrow(/SCHEMA_INVALID/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("loadAllHosts", () => {
  it("returns every host in hosts/ keyed by name", () => {
    const hosts = loadAllHosts(join(FIX, "hosts"));
    expect(Object.keys(hosts).sort()).toEqual(["mac-studio", "qnap-ts453d", "win-desktop"]);
  });

  it("throws PlanError(SCHEMA_INVALID) when a host file is malformed", () => {
    expect(() => loadAllHosts(join(FIX, "no-such-dir"))).toThrow();
  });
});
