import { describe, it, expect } from "bun:test";
import { join } from "path";
import { plan } from "../src/plan.ts";
import { effectiveSync, loadAllHosts, loadFolderManifest, type FolderManifest } from "../src/load.ts";
import type { SyncthingOp } from "../src/types.ts";

const FIX = join(import.meta.dir, "fixtures");

function fixedSecretsResolver(map: Record<string, string>) {
  return { resolve: (ref: string) => map[ref] ?? `__missing:${ref}` };
}

const SECRETS = {
  "secrets/syncthing-device-ids.enc.yaml#mac-studio": "MACDEV-MACDEV-MACDEV-MACDEV-MACDEV",
  "secrets/syncthing-device-ids.enc.yaml#qnap-ts453d": "QNAPDV-QNAPDV-QNAPDV-QNAPDV-QNAPDV",
  "secrets/syncthing-device-ids.enc.yaml#win-desktop": "WINDEV-WINDEV-WINDEV-WINDEV-WINDEV",
};

function testFolder(): FolderManifest {
  return loadFolderManifest(join(FIX, "folders/test.yaml"));
}

function folderConfigFor(ops: SyncthingOp[]) {
  const add = ops.find((o) => o.kind === "addFolder");
  if (!add || add.kind !== "addFolder") throw new Error("no addFolder op");
  return add.folder;
}

describe("effectiveSync", () => {
  it("defaults to realtime with a 60-minute window cap", () => {
    expect(effectiveSync(testFolder(), "qnap-ts453d")).toEqual({
      mode: "realtime",
      maxWindowMinutes: 60,
    });
  });

  it("member override wins over the folder-level sync block", () => {
    const folder = testFolder();
    folder.sync = { mode: "realtime" };
    folder.overrides = {
      "qnap-ts453d": { sync: { mode: "scheduled", schedule: "0 */4 * * *", max_window_minutes: 45 } },
    };
    expect(effectiveSync(folder, "qnap-ts453d")).toEqual({
      mode: "scheduled",
      schedule: "0 */4 * * *",
      maxWindowMinutes: 45,
    });
    expect(effectiveSync(folder, "mac-studio").mode).toBe("realtime");
  });

  it("drops the schedule for non-scheduled modes", () => {
    const folder = testFolder();
    folder.overrides = { "qnap-ts453d": { sync: { mode: "manual", schedule: "0 4 * * *" } } };
    expect(effectiveSync(folder, "qnap-ts453d").schedule).toBeUndefined();
  });
});

describe("plan with sync modes", () => {
  it("forces the watcher off and stretches rescan for a scheduled member, leaving realtime members alone", () => {
    const folder = testFolder();
    folder.overrides = {
      "qnap-ts453d": { sync: { mode: "scheduled", schedule: "0 */4 * * *" } },
    };
    const hosts = loadAllHosts(join(FIX, "hosts"));
    const result = plan({
      folder,
      hosts,
      compiledIgnoreLines: [],
      filtersFile: "",
      secrets: fixedSecretsResolver(SECRETS),
    });

    const qnap = folderConfigFor(result.perHost["qnap-ts453d"]!);
    expect(qnap.fsWatcherEnabled).toBe(false);
    expect(qnap.rescanIntervalS).toBe(86400);

    const mac = folderConfigFor(result.perHost["mac-studio"]!);
    // The fixture folder sets fs_watcher_enabled: true folder-wide.
    expect(mac.fsWatcherEnabled).toBe(true);
    expect(mac.rescanIntervalS).toBeUndefined();
  });

  it("warns when an explicit fs_watcher_enabled: true is overridden by a held mode", () => {
    const folder = testFolder();
    folder.overrides = { "qnap-ts453d": { sync: { mode: "manual" } } };
    const hosts = loadAllHosts(join(FIX, "hosts"));
    const result = plan({
      folder,
      hosts,
      compiledIgnoreLines: [],
      filtersFile: "",
      secrets: fixedSecretsResolver(SECRETS),
    });
    expect(result.warnings.some((w) => w.includes("qnap-ts453d") && w.includes("watcher"))).toBe(true);
  });
});
