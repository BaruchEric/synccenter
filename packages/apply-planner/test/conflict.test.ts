import { describe, it, expect } from "bun:test";
import { mapPolicy } from "../src/conflict.ts";

describe("mapPolicy", () => {
  it("maps 'newer' to rclone --conflict-resolve=newer + Syncthing maxConflicts -1", () => {
    const m = mapPolicy("newer");
    expect(m.rcloneFlags).toContain("--conflict-resolve=newer");
    expect(m.syncthingMaxConflicts).toBe(-1);
  });

  it("maps 'older' symmetrically", () => {
    const m = mapPolicy("older");
    expect(m.rcloneFlags).toContain("--conflict-resolve=older");
    expect(m.syncthingMaxConflicts).toBe(-1);
  });

  it("maps 'keep-both' to rclone --conflict-resolve=none and surfaces all conflicts", () => {
    const m = mapPolicy("keep-both");
    expect(m.rcloneFlags).toContain("--conflict-resolve=none");
    expect(m.syncthingMaxConflicts).toBe(-1);
  });

  it("maps 'require-resolve' to rclone --conflict-resolve=none and Syncthing maxConflicts 0", () => {
    const m = mapPolicy("require-resolve");
    expect(m.rcloneFlags).toContain("--conflict-resolve=none");
    expect(m.syncthingMaxConflicts).toBe(0);
  });

  it("returns the system default when no policy is given", () => {
    const m = mapPolicy(undefined);
    expect(m.rcloneFlags).toContain("--conflict-resolve=newer");
    expect(m.syncthingMaxConflicts).toBe(-1);
  });
});
