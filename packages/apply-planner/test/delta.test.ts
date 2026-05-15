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
