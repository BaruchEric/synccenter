import { describe, it, expect, mock } from "bun:test";
import { apply } from "../src/apply.ts";
import type { ApplyPlan, AdapterPool, SyncthingFolderConfig } from "../src/types.ts";

function makePool(perHost: Record<string, { addFolder: any; setIgnores: any; addDevice: any; patchFolder: any }>): AdapterPool {
  return {
    syncthing: (host) => ({
      addFolder: perHost[host]?.addFolder ?? (async () => undefined),
      setIgnores: perHost[host]?.setIgnores ?? (async () => undefined),
      addDevice: perHost[host]?.addDevice ?? (async () => undefined),
      patchFolder: perHost[host]?.patchFolder ?? (async () => undefined),
    } as any),
    rclone: () => ({} as any),
  };
}

const BASE_FOLDER: SyncthingFolderConfig = { id: "test", label: "test", path: "/p", type: "sendreceive", devices: [] };

const PLAN_TWO_HOSTS: ApplyPlan = {
  folder: "test",
  perHost: {
    "mac": [{ kind: "addFolder", host: "mac", folder: BASE_FOLDER }, { kind: "setIgnores", host: "mac", folderId: "test", lines: [".DS_Store"] }],
    "qnap": [{ kind: "addFolder", host: "qnap", folder: BASE_FOLDER }, { kind: "setIgnores", host: "qnap", folderId: "test", lines: [".DS_Store"] }],
  },
  schedule: [],
  warnings: [],
};

describe("apply", () => {
  it("executes operations in order per host and returns 'applied' status", async () => {
    const macAdd = mock(async () => undefined);
    const macSet = mock(async () => undefined);
    const pool = makePool({ "mac": { addFolder: macAdd, setIgnores: macSet, addDevice: async () => undefined, patchFolder: async () => undefined } });
    const res = await apply(PLAN_TWO_HOSTS, pool, {});
    expect(res.hosts.find((h) => h.host === "mac")?.status).toBe("applied");
    expect(macAdd).toHaveBeenCalledTimes(1);
    expect(macSet).toHaveBeenCalledTimes(1);
  });

  it("per-host independence: failure on one host does not abort the other", async () => {
    const pool = makePool({
      "mac": { addFolder: async () => { throw new Error("boom"); }, setIgnores: async () => undefined, addDevice: async () => undefined, patchFolder: async () => undefined },
      "qnap": { addFolder: async () => undefined, setIgnores: async () => undefined, addDevice: async () => undefined, patchFolder: async () => undefined },
    });
    const res = await apply(PLAN_TWO_HOSTS, pool, {});
    expect(res.hosts.find((h) => h.host === "mac")?.status).toBe("failed");
    expect(res.hosts.find((h) => h.host === "qnap")?.status).toBe("applied");
  }, 10_000);

  it("dryRun returns 'skipped' for every host and calls nothing", async () => {
    const macAdd = mock(async () => undefined);
    const pool = makePool({ "mac": { addFolder: macAdd, setIgnores: async () => undefined, addDevice: async () => undefined, patchFolder: async () => undefined } });
    const res = await apply(PLAN_TWO_HOSTS, pool, { dryRun: true });
    expect(res.hosts.every((h) => h.status === "skipped")).toBe(true);
    expect(macAdd).toHaveBeenCalledTimes(0);
  });
});
