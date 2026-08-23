import { describe, it, expect } from "bun:test";
import { toSyncthingVersioning, parseSeconds } from "../src/versioning.ts";
import { PlanError } from "../src/errors.ts";

describe("toSyncthingVersioning", () => {
  it("returns undefined when the manifest has no versioning block (unmanaged)", () => {
    expect(toSyncthingVersioning(undefined, "f")).toBeUndefined();
  });

  it("maps off (and a typeless block) to Syncthing's empty type", () => {
    expect(toSyncthingVersioning({ type: "off" }, "f")).toEqual({ type: "", params: {} });
    expect(toSyncthingVersioning({}, "f")).toEqual({ type: "", params: {} });
  });

  it("maps staggered maxAge 30d to seconds and fills Syncthing's defaults", () => {
    expect(toSyncthingVersioning({ type: "staggered", params: { maxAge: "30d" } }, "f")).toEqual({
      type: "staggered",
      params: { maxAge: "2592000", cleanInterval: "3600", versionsPath: "" },
    });
  });

  it("passes explicit seconds and extra params through as strings", () => {
    expect(
      toSyncthingVersioning(
        { type: "staggered", params: { maxAge: 86400, cleanInterval: "2h", versionsPath: "/v" } },
        "f",
      ),
    ).toEqual({ type: "staggered", params: { maxAge: "86400", cleanInterval: "7200", versionsPath: "/v" } });
    expect(toSyncthingVersioning({ type: "simple", params: { keep: 3 } }, "f")).toEqual({
      type: "simple",
      params: { keep: "3", cleanoutDays: "0" },
    });
    expect(toSyncthingVersioning({ type: "trash" }, "f")).toEqual({ type: "trash", params: { cleanoutDays: "0" } });
  });

  it("rejects a duration it cannot read with VERSIONING_INVALID", () => {
    let caught: unknown;
    try {
      toSyncthingVersioning({ type: "staggered", params: { maxAge: "a month" } }, "arik");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PlanError);
    expect((caught as PlanError).code).toBe("VERSIONING_INVALID");
    expect((caught as PlanError).message).toContain("arik");
  });
});

describe("parseSeconds", () => {
  it("handles every unit and bare seconds", () => {
    expect(parseSeconds("90s", "k", "f")).toBe(90);
    expect(parseSeconds("45m", "k", "f")).toBe(2700);
    expect(parseSeconds("12h", "k", "f")).toBe(43200);
    expect(parseSeconds("30d", "k", "f")).toBe(2592000);
    expect(parseSeconds("2w", "k", "f")).toBe(1209600);
    expect(parseSeconds("3600", "k", "f")).toBe(3600);
    expect(parseSeconds(0, "k", "f")).toBe(0);
  });
});
