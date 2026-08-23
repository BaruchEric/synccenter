import { describe, it, expect, mock } from "bun:test";
import { apply } from "../src/apply.ts";
import type { ApplyPlan, AdapterPool, SyncthingFolderConfig } from "../src/types.ts";

const NOT_FOUND = Object.assign(new Error("404"), { status: 404 });

function makePool(perHost: Record<string, { addFolder: any; setIgnores: any; addDevice: any; patchFolder: any; getFolder?: any }>): AdapterPool {
  return {
    syncthing: (host) => ({
      addFolder: perHost[host]?.addFolder ?? (async () => undefined),
      setIgnores: perHost[host]?.setIgnores ?? (async () => undefined),
      addDevice: perHost[host]?.addDevice ?? (async () => undefined),
      patchFolder: perHost[host]?.patchFolder ?? (async () => undefined),
      // Default: the folder is not on the host yet, so addFolder POSTs.
      getFolder: perHost[host]?.getFolder ?? (async () => { throw NOT_FOUND; }),
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

  // Syncthing answers the POST with 200 and reports a whole-file parse failure
  // in the body. One unsupported glob discards EVERY rule, so an apply that
  // ignores this reports success on a folder now syncing with no exclusions.
  it("fails the host when Syncthing rejects the ignore file", async () => {
    const setIgnores = mock(async () => ({
      ignore: [".DS_Store"],
      expanded: [],
      error: 'invalid pattern "[a-gi-z]": parse error',
    }));
    const pool = makePool({
      "mac": { addFolder: async () => undefined, setIgnores, addDevice: async () => undefined, patchFolder: async () => undefined },
    });
    const res = await apply(PLAN_TWO_HOSTS, pool, {});
    const mac = res.hosts.find((h) => h.host === "mac");
    expect(mac?.status).toBe("failed");
    expect(mac?.error?.message).toContain("ALL ignore rules are inactive");
    // A rejected pattern is not transient — it must not be retried.
    expect(setIgnores).toHaveBeenCalledTimes(1);
  });

  // POST /rest/config/folders replaces an existing folder wholesale, which is
  // how every re-apply wiped versioning (and anything else unmanaged) until
  // 2026-08-22. An existing folder must be PATCHed, never re-POSTed.
  it("PATCHes an existing folder instead of re-POSTing it", async () => {
    const add = mock(async () => undefined);
    const patch = mock(async (_id: string, _cfg: SyncthingFolderConfig) => undefined);
    const pool = makePool({
      "mac": { addFolder: add, patchFolder: patch, setIgnores: async () => undefined, addDevice: async () => undefined, getFolder: async () => ({ ...BASE_FOLDER, paused: false }) },
      "qnap": { addFolder: add, patchFolder: patch, setIgnores: async () => undefined, addDevice: async () => undefined },
    });
    const res = await apply(PLAN_TWO_HOSTS, pool, {});
    expect(res.hosts.every((h) => h.status === "applied")).toBe(true);
    // mac had the folder: one PATCH with the planned config; qnap did not: one POST.
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith("test", BASE_FOLDER);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("fails the host when the existence check fails for a reason other than 404", async () => {
    const add = mock(async () => undefined);
    const pool = makePool({
      "mac": { addFolder: add, patchFolder: async () => undefined, setIgnores: async () => undefined, addDevice: async () => undefined, getFolder: async () => { throw Object.assign(new Error("401"), { status: 401 }); } },
    });
    const res = await apply(PLAN_TWO_HOSTS, pool, {});
    expect(res.hosts.find((h) => h.host === "mac")?.status).toBe("failed");
    expect(add).toHaveBeenCalledTimes(0);
  });

  it("dryRun returns 'skipped' for every host and calls nothing", async () => {
    const macAdd = mock(async () => undefined);
    const pool = makePool({ "mac": { addFolder: macAdd, setIgnores: async () => undefined, addDevice: async () => undefined, patchFolder: async () => undefined } });
    const res = await apply(PLAN_TWO_HOSTS, pool, { dryRun: true });
    expect(res.hosts.every((h) => h.status === "skipped")).toBe(true);
    expect(macAdd).toHaveBeenCalledTimes(0);
  });
});
