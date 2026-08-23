import { PlanError } from "./errors.ts";
import type { FolderManifest } from "./load.ts";
import type { SyncthingVersioningConfig } from "./types.ts";

type ManifestVersioning = NonNullable<FolderManifest["versioning"]>;

/** Params Syncthing reads as seconds; the manifest may write them as durations ("30d"). */
const SECONDS_KEYS = new Set(["maxAge", "cleanInterval"]);

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

/** What Syncthing itself fills in when the GUI creates each versioning type. */
export const DEFAULT_PARAMS: Record<"trash" | "simple" | "staggered", Record<string, string>> = {
  trash: { cleanoutDays: "0" },
  simple: { keep: "5", cleanoutDays: "0" },
  staggered: { maxAge: "31536000", cleanInterval: "3600", versionsPath: "" },
};

/**
 * Map a manifest `versioning:` block onto Syncthing's `folder.versioning` wire
 * shape. Syncthing stores every param as a string, and staggered `maxAge` /
 * `cleanInterval` are seconds, so `maxAge: 30d` becomes `"2592000"`. Params the
 * manifest leaves out get Syncthing's own defaults, so the result is exactly
 * what the GUI would have written. `type: off` (or a block with no type) maps
 * to Syncthing's empty type, which clears versioning on the live folder.
 * `undefined` in, `undefined` out: a manifest without the block does not
 * manage versioning at all.
 */
export function toSyncthingVersioning(
  v: ManifestVersioning | undefined,
  folderName: string,
): SyncthingVersioningConfig | undefined {
  if (!v) return undefined;
  const type = v.type ?? "off";
  if (type === "off") return { type: "", params: {} };
  const params: Record<string, string> = {};
  for (const [key, raw] of Object.entries(v.params ?? {})) {
    params[key] = SECONDS_KEYS.has(key) ? String(parseSeconds(raw, key, folderName)) : String(raw);
  }
  for (const [key, value] of Object.entries(DEFAULT_PARAMS[type])) {
    if (!(key in params)) params[key] = value;
  }
  return { type, params };
}

/**
 * Syncthing's default for a versioning param, or undefined when the param has
 * none. A live folder that omits a param behaves exactly as if it held the
 * default, so the delta treats the two as equal.
 */
export function defaultVersioningParam(type: string, key: string): string | undefined {
  if (type === "trash" || type === "simple" || type === "staggered") return DEFAULT_PARAMS[type][key];
  return undefined;
}

/** Accepts whole seconds (number or digit string) or `<n><s|m|h|d|w>`. */
export function parseSeconds(raw: unknown, key: string, folderName: string): number {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return raw;
  if (typeof raw === "string") {
    const m = /^\s*(\d+)\s*([smhdw])?\s*$/.exec(raw);
    if (m) return Number(m[1]) * (m[2] ? UNIT_SECONDS[m[2]]! : 1);
  }
  throw new PlanError(
    `VERSIONING_INVALID: folder ${folderName} versioning.params.${key} must be whole seconds or a duration like 30d, got ${JSON.stringify(raw)}`,
    "VERSIONING_INVALID",
  );
}
