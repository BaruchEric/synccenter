import { describe, it, expect } from "bun:test";
import { createSecretsResolver } from "../src/secrets.ts";

describe("createSecretsResolver", () => {
  it("invokes sops with --extract and returns the resolved value", () => {
    const calls: { argv: string[] }[] = [];
    const resolver = createSecretsResolver({
      configDir: "/cfg",
      spawn: (argv: string[]) => {
        calls.push({ argv });
        return { stdout: "the-secret", status: 0, stderr: "" };
      },
    });
    const val = resolver.resolve("secrets/syncthing-api-keys.enc.yaml#mac-studio");
    expect(val).toBe("the-secret");
    expect(calls[0]!.argv).toEqual([
      "sops", "-d", "--extract", '["mac-studio"]', "/cfg/secrets/syncthing-api-keys.enc.yaml",
    ]);
  });

  it("caches subsequent resolves of the same ref", () => {
    let count = 0;
    const resolver = createSecretsResolver({
      configDir: "/cfg",
      spawn: () => { count++; return { stdout: "x", status: 0, stderr: "" }; },
    });
    resolver.resolve("secrets/a.enc.yaml#k");
    resolver.resolve("secrets/a.enc.yaml#k");
    expect(count).toBe(1);
  });

  it("throws SECRET_REF_INVALID when the ref has no '#'", () => {
    const resolver = createSecretsResolver({
      configDir: "/cfg",
      spawn: () => { throw new Error("should not be called"); },
    });
    expect(() => resolver.resolve("secrets/a.enc.yaml")).toThrow(/SECRET_REF_INVALID/);
  });

  it("throws SOPS_DECRYPT_FAILED when sops exits non-zero", () => {
    const resolver = createSecretsResolver({
      configDir: "/cfg",
      spawn: () => ({ stdout: "", status: 1, stderr: "no key" }),
    });
    expect(() => resolver.resolve("secrets/a.enc.yaml#k")).toThrow(/SOPS_DECRYPT_FAILED/);
  });
});
