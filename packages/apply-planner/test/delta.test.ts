import { describe, it, expect } from "bun:test";
import { computeDelta } from "../src/delta.ts";
import type { ApplyPlan, SyncthingOp } from "../src/types.ts";

const PLAN: ApplyPlan = {
  folder: "test",
  perHost: {
    "mac-studio": [
      { kind: "addFolder", host: "mac-studio", folder: { id: "test", label: "test", path: "/p/mac", type: "sendreceive", devices: [{ deviceID: "X" }] } },
      { kind: "setIgnores", host: "mac-studio", folderId: "test", lines: [".DS_Store"] },
    ] as SyncthingOp[],
  },
  schedule: [],
  warnings: [],
};

describe("computeDelta", () => {
  it("classifies all ops as manifest-only when the folder doesn't exist on the host", () => {
    const delta = computeDelta(PLAN, {
      "mac-studio": { folder: null, ignores: null },
    });
    expect(delta.manifestOnly).toHaveLength(2);
    expect(delta.liveOnly).toHaveLength(0);
    expect(delta.divergent).toHaveLength(0);
  });

  it("returns liveOnly when live has a folder the plan doesn't (different folder id)", () => {
    const delta = computeDelta(PLAN, {
      "mac-studio": {
        folder: { id: "ghost", label: "ghost", path: "/p", type: "sendreceive", devices: [] },
        ignores: null,
      },
    });
    expect(delta.liveOnly).toEqual([{ host: "mac-studio", folderId: "ghost" }]);
  });

  it("returns divergent when the plan declares versioning the live folder lacks", () => {
    const withVersioning: ApplyPlan = {
      ...PLAN,
      perHost: {
        "mac-studio": [
          {
            kind: "addFolder",
            host: "mac-studio",
            folder: {
              id: "test", label: "test", path: "/p/mac", type: "sendreceive", devices: [{ deviceID: "X" }],
              versioning: { type: "staggered", params: { maxAge: "2592000", cleanInterval: "3600", versionsPath: "" } },
            },
          },
        ] as SyncthingOp[],
      },
    };
    const off = computeDelta(withVersioning, {
      "mac-studio": {
        folder: { id: "test", label: "test", path: "/p/mac", type: "sendreceive", devices: [{ deviceID: "X" }], versioning: { type: "", params: {} } },
        ignores: [],
      },
    });
    expect(off.divergent.map((d) => d.path)).toEqual(["perHost.mac-studio.folder.versioning"]);
    // Live returns extra params (fsPath, cleanupIntervalS live on the folder,
    // not in params); only the planned type and params count.
    const matching = computeDelta(withVersioning, {
      "mac-studio": {
        folder: {
          id: "test", label: "test", path: "/p/mac", type: "sendreceive", devices: [{ deviceID: "X" }],
          versioning: { type: "staggered", params: { maxAge: "2592000", cleanInterval: "3600", versionsPath: "" }, cleanupIntervalS: 3600, fsPath: "", fsType: "basic" },
        },
        ignores: [],
      },
    });
    expect(matching.divergent).toEqual([]);
    // A hand-armed folder that never wrote cleanInterval/versionsPath behaves as
    // the defaults the plan asks for; a different maxAge is still drift.
    const armedByHand = (maxAge: string) =>
      computeDelta(withVersioning, {
        "mac-studio": {
          folder: { id: "test", label: "test", path: "/p/mac", type: "sendreceive", devices: [{ deviceID: "X" }], versioning: { type: "staggered", params: { maxAge, cleanoutDays: "30" } } },
          ignores: [],
        },
      });
    expect(armedByHand("2592000").divergent).toEqual([]);
    expect(armedByHand("86400").divergent.map((d) => d.path)).toEqual(["perHost.mac-studio.folder.versioning"]);
  });

  it("returns divergent when path differs between plan and live", () => {
    const delta = computeDelta(PLAN, {
      "mac-studio": {
        folder: { id: "test", label: "test", path: "/WRONG", type: "sendreceive", devices: [{ deviceID: "X" }] },
        ignores: [".DS_Store"],
      },
    });
    expect(delta.divergent).toEqual([
      { host: "mac-studio", path: "perHost.mac-studio.folder.path", expected: "/p/mac", actual: "/WRONG" },
    ]);
  });

  it("returns DIVERGENT_IGNORES marker when ignore list differs", () => {
    const delta = computeDelta(PLAN, {
      "mac-studio": {
        folder: { id: "test", label: "test", path: "/p/mac", type: "sendreceive", devices: [{ deviceID: "X" }] },
        ignores: ["DIFFERENT"],
      },
    });
    expect(delta.divergent.some((d) => d.path.endsWith(".ignores"))).toBe(true);
  });
});
