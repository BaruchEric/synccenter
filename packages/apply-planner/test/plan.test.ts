import { describe, it, expect } from "bun:test";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { plan } from "../src/plan.ts";
import { loadFolderManifest, loadAllHosts } from "../src/load.ts";

const FIX = join(import.meta.dir, "fixtures");
const GOLDEN_DIR = join(import.meta.dir, "golden");

function fixedSecretsResolver(map: Record<string, string>) {
  return { resolve: (ref: string) => map[ref] ?? `__missing:${ref}` };
}

const SECRETS = {
  "secrets/syncthing-api-keys.enc.yaml#mac-studio": "MAC-KEY",
  "secrets/syncthing-api-keys.enc.yaml#qnap-ts453d": "QNAP-KEY",
  "secrets/syncthing-api-keys.enc.yaml#win-desktop": "WIN-KEY",
  "secrets/syncthing-device-ids.enc.yaml#mac-studio": "MACDEV-MACDEV-MACDEV-MACDEV-MACDEV",
  "secrets/syncthing-device-ids.enc.yaml#qnap-ts453d": "QNAPDV-QNAPDV-QNAPDV-QNAPDV-QNAPDV",
  "secrets/syncthing-device-ids.enc.yaml#win-desktop": "WINDEV-WINDEV-WINDEV-WINDEV-WINDEV",
};

describe("plan", () => {
  it("plan(test) matches golden plan-test.json", () => {
    const folder = loadFolderManifest(join(FIX, "folders/test.yaml"));
    const hosts = loadAllHosts(join(FIX, "hosts"));
    const result = plan({
      folder,
      hosts,
      compiledIgnoreLines: [".DS_Store", "Thumbs.db", "*.tmp"],
      filtersFile: "",
      secrets: fixedSecretsResolver(SECRETS),
    });
    const path = join(GOLDEN_DIR, "plan-test.json");
    if (process.env["BUN_UPDATE_GOLDEN"] === "1" || !existsSync(path)) {
      writeFileSync(path, JSON.stringify(result, null, 2) + "\n", "utf8");
    }
    expect(JSON.parse(JSON.stringify(result))).toEqual(JSON.parse(readFileSync(path, "utf8")));
  });

  it("plan(example-code-projects) matches golden plan-example-code-projects.json (with schedule)", () => {
    const folder = loadFolderManifest(join(FIX, "folders/example-code-projects.yaml"));
    const hosts = loadAllHosts(join(FIX, "hosts"));
    const result = plan({
      folder,
      hosts,
      compiledIgnoreLines: ["**/node_modules/", "**/.env"],
      filtersFile: "/share/synccenter-config/compiled/dev-monorepo/filter.rclone",
      secrets: fixedSecretsResolver(SECRETS),
    });
    const path = join(GOLDEN_DIR, "plan-example-code-projects.json");
    if (process.env["BUN_UPDATE_GOLDEN"] === "1" || !existsSync(path)) {
      writeFileSync(path, JSON.stringify(result, null, 2) + "\n", "utf8");
    }
    expect(JSON.parse(JSON.stringify(result))).toEqual(JSON.parse(readFileSync(path, "utf8")));
  });

  it("throws PlanError(UNKNOWN_HOST) when paths references a host not in hosts/", () => {
    const folder = loadFolderManifest(join(FIX, "folders/test.yaml"));
    const hosts = { "mac-studio": loadAllHosts(join(FIX, "hosts"))["mac-studio"]! };
    expect(() =>
      plan({ folder, hosts, compiledIgnoreLines: [], filtersFile: "", secrets: fixedSecretsResolver(SECRETS) }),
    ).toThrow(/UNKNOWN_HOST/);
  });

  it("throws PlanError(NO_CLOUD_EDGE_FOR_BISYNC) when no host has role: cloud-edge but folder has cloud:", () => {
    const folder = loadFolderManifest(join(FIX, "folders/example-code-projects.yaml"));
    const hosts = loadAllHosts(join(FIX, "hosts"));
    for (const h of Object.values(hosts)) h.role = "mesh-node";
    expect(() =>
      plan({ folder, hosts, compiledIgnoreLines: [], filtersFile: "", secrets: fixedSecretsResolver(SECRETS) }),
    ).toThrow(/NO_CLOUD_EDGE_FOR_BISYNC/);
  });
});
