import { describe, it, expect } from "bun:test";
import { buildSchedulePlan } from "../src/schedule.ts";
import type { FolderManifest, HostManifest } from "../src/load.ts";

const QNAP: HostManifest = {
  name: "qnap-ts453d", hostname: "qnap.local", os: "qnap", role: "cloud-edge",
  syncthing: { install_method: "docker", api_url: "http://127.0.0.1:8384", api_key_ref: "secrets/x#qnap", device_id_ref: "secrets/y#qnap" },
};

describe("buildSchedulePlan", () => {
  it("returns empty array when folder has no cloud block", () => {
    const folder: FolderManifest = { name: "test", ruleset: "x", type: "send-receive", paths: { "qnap-ts453d": "/p" } };
    expect(buildSchedulePlan(folder, QNAP, "/cfg/compiled/x/filter.rclone")).toEqual([]);
  });

  it("emits a SchedulePlan with command containing path1, path2, filters_file", () => {
    const folder: FolderManifest = {
      name: "code", ruleset: "dev-monorepo", type: "send-receive",
      paths: { "qnap-ts453d": "/share/Sync/code" },
      cloud: {
        rclone_remote: "gdrive", remote_path: "sync/code",
        bisync: { schedule: "*/15 * * * *", flags: ["--resilient"] },
      },
    };
    const plans = buildSchedulePlan(folder, QNAP, "/cfg/compiled/dev-monorepo/filter.rclone");
    expect(plans).toHaveLength(1);
    expect(plans[0]!.anchor).toBe("qnap-ts453d");
    expect(plans[0]!.cron).toBe("*/15 * * * *");
    expect(plans[0]!.command).toContain("/share/Sync/code");
    expect(plans[0]!.command).toContain("gdrive:sync/code");
    expect(plans[0]!.command).toContain("--filters-file=/cfg/compiled/dev-monorepo/filter.rclone");
    expect(plans[0]!.command).toContain("--resilient");
  });
});
