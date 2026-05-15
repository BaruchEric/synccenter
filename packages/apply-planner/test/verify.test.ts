import { describe, it, expect } from "bun:test";
import { verify } from "../src/verify.ts";
import type { ApplyPlan, AdapterPool, SyncthingFolderConfig } from "../src/types.ts";

const FOLDER: SyncthingFolderConfig = { id: "test", label: "test", path: "/p/mac", type: "sendreceive", devices: [{ deviceID: "X" }] };

function poolWith(host: string, folder: SyncthingFolderConfig | null, ignores: string[] | null): AdapterPool {
  return {
    syncthing: () => ({
      getFolder: async () => folder,
      getIgnores: async () => ({ ignore: ignores ?? [] }),
    } as any),
    rclone: () => ({} as any),
  };
}

const PLAN: ApplyPlan = {
  folder: "test",
  perHost: {
    "mac": [{ kind: "addFolder", host: "mac", folder: FOLDER }, { kind: "setIgnores", host: "mac", folderId: "test", lines: [".DS_Store"] }],
  },
  schedule: [],
  warnings: [],
};

describe("verify", () => {
  it("returns verified=true when live state matches the plan", async () => {
    const res = await verify(PLAN, poolWith("mac", FOLDER, [".DS_Store"]));
    expect(res.verified).toBe(true);
    expect(res.report.divergent).toHaveLength(0);
  });

  it("returns verified=false when path differs", async () => {
    const res = await verify(PLAN, poolWith("mac", { ...FOLDER, path: "/wrong" }, [".DS_Store"]));
    expect(res.verified).toBe(false);
    expect(res.report.divergent.some((d) => d.path.endsWith(".path"))).toBe(true);
  });
});
