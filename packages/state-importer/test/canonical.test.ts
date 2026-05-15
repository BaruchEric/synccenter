import { describe, it, expect } from "bun:test";
import { parse } from "yaml";
import { canonicalEmit, FOLDER_KEY_ORDER, HOST_KEY_ORDER } from "../src/canonical.ts";

describe("canonicalEmit", () => {
  it("emits folder fields in schema order regardless of input key order", () => {
    const input = {
      paths: { "mac-studio": "/a", "qnap-ts453d": "/b" },
      type: "send-receive",
      ruleset: "dev-monorepo",
      name: "code",
    };
    const out = canonicalEmit(input, FOLDER_KEY_ORDER);
    const lines = out.split("\n").filter((l) => /^[a-z]/.test(l));
    expect(lines).toEqual([
      "name: code",
      "ruleset: dev-monorepo",
      "type: send-receive",
      "paths:",
    ]);
  });

  it("emits host fields in schema order", () => {
    const input = {
      syncthing: { install_method: "brew", api_url: "x", api_key_ref: "y", device_id_ref: "z" },
      os: "macos",
      role: "mesh-node",
      hostname: "mac.local",
      name: "mac-studio",
    };
    const out = canonicalEmit(input, HOST_KEY_ORDER);
    const lines = out.split("\n").filter((l) => /^[a-z]/.test(l));
    expect(lines).toEqual([
      "name: mac-studio",
      "hostname: mac.local",
      "os: macos",
      "role: mesh-node",
      "syncthing:",
    ]);
  });

  it("round-trips: parse(canonicalEmit(parse(x))) deepEquals parse(x)", () => {
    const yaml = `name: code\nruleset: dev-monorepo\ntype: send-receive\npaths:\n  mac-studio: /a\n  qnap-ts453d: /b\nignore_perms: true\n`;
    const data = parse(yaml);
    const reEmitted = canonicalEmit(data, FOLDER_KEY_ORDER);
    expect(parse(reEmitted)).toEqual(data);
  });

  it("is stable across two emits (no drift)", () => {
    const data = { name: "x", ruleset: "y", type: "send-receive", paths: { a: "/p" } };
    const first = canonicalEmit(data, FOLDER_KEY_ORDER);
    const second = canonicalEmit(parse(first), FOLDER_KEY_ORDER);
    expect(first).toBe(second);
  });

  it("uses 2-space indent and no flow style for sequences", () => {
    const data = { name: "x", excludes: ["a", "b", "c"] };
    const out = canonicalEmit(data, ["name", "excludes"]);
    expect(out).toContain("excludes:\n  - a\n  - b\n  - c\n");
    expect(out).not.toContain("["); // no flow style
  });
});
