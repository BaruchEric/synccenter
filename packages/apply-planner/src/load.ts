import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { parse } from "yaml";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import { PlanError } from "./errors.ts";

const schemaDir = join(import.meta.dir, "..", "..", "schema");
const ajv = new Ajv2020({ strict: false, allErrors: true });

let folderValidator: ValidateFunction | null = null;
let hostValidator: ValidateFunction | null = null;

function folderSchema(): ValidateFunction {
  if (folderValidator) return folderValidator;
  const schema = JSON.parse(readFileSync(join(schemaDir, "folder.schema.json"), "utf8"));
  folderValidator = ajv.compile(schema);
  return folderValidator;
}

function hostSchema(): ValidateFunction {
  if (hostValidator) return hostValidator;
  const schema = JSON.parse(readFileSync(join(schemaDir, "host.schema.json"), "utf8"));
  hostValidator = ajv.compile(schema);
  return hostValidator;
}

export interface FolderManifest {
  name: string;
  ruleset: string;
  type: "send-receive" | "send-only" | "receive-only" | "receive-encrypted";
  paths: Record<string, string>;
  cloud?: {
    rclone_remote: string;
    remote_path: string;
    anchor?: string;
    bisync?: { schedule?: string; flags?: string[] };
  };
  conflict?: {
    policy: "newer" | "older" | "keep-both" | "require-resolve";
    surface_to_ui?: boolean;
  };
  versioning?: {
    type?: "off" | "trash" | "simple" | "staggered";
    params?: Record<string, unknown>;
  };
  overrides?: Record<
    string,
    Partial<Omit<FolderManifest, "name" | "ruleset" | "paths" | "cloud" | "conflict" | "overrides">>
  >;
  ignore_perms?: boolean;
  fs_watcher_enabled?: boolean;
  fs_watcher_delay_s?: number;
}

export interface HostManifest {
  name: string;
  hostname: string;
  ip?: string;
  os: "macos" | "linux" | "windows" | "qnap";
  role: "mesh-node" | "hub" | "cloud-edge";
  ssh?: { user: string; port?: number; key_ref?: string; host?: string };
  syncthing: {
    install_method: "brew" | "docker" | "qpkg" | "synctrayzor" | "winget+nssm";
    api_url: string;
    api_key_ref: string;
    device_id_ref: string;
    binary_path?: string;
    home_dir?: string;
  };
  rclone?: { rcd_url: string; auth_ref: string };
}

export function loadFolderManifest(path: string): FolderManifest {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new PlanError(
      `MANIFEST_NOT_FOUND: folder manifest not found: ${path}`,
      "MANIFEST_NOT_FOUND",
      cause,
    );
  }
  const parsed = parse(raw);
  const validate = folderSchema();
  if (!validate(parsed)) {
    throw new PlanError(
      `SCHEMA_INVALID in ${path}: ${ajv.errorsText(validate.errors)}`,
      "SCHEMA_INVALID",
    );
  }
  return parsed as FolderManifest;
}

export function loadHostManifest(path: string): HostManifest {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new PlanError(
      `MANIFEST_NOT_FOUND: host manifest not found: ${path}`,
      "MANIFEST_NOT_FOUND",
      cause,
    );
  }
  const parsed = parse(raw);
  const validate = hostSchema();
  if (!validate(parsed)) {
    throw new PlanError(
      `SCHEMA_INVALID in ${path}: ${ajv.errorsText(validate.errors)}`,
      "SCHEMA_INVALID",
    );
  }
  return parsed as HostManifest;
}

export function loadAllHosts(hostsDir: string): Record<string, HostManifest> {
  if (!existsSync(hostsDir)) {
    throw new PlanError(
      `MANIFEST_NOT_FOUND: hosts dir not found: ${hostsDir}`,
      "MANIFEST_NOT_FOUND",
    );
  }
  const out: Record<string, HostManifest> = {};
  for (const f of readdirSync(hostsDir)) {
    if (!f.endsWith(".yaml") || f === "README.md") continue;
    const host = loadHostManifest(join(hostsDir, f));
    out[host.name] = host;
  }
  return out;
}
