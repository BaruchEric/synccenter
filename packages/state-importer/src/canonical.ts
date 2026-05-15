import { stringify } from "yaml";

export const FOLDER_KEY_ORDER = [
  "name",
  "ruleset",
  "type",
  "paths",
  "cloud",
  "conflict",
  "versioning",
  "overrides",
  "ignore_perms",
  "fs_watcher_enabled",
  "fs_watcher_delay_s",
] as const;

export const HOST_KEY_ORDER = [
  "name",
  "hostname",
  "ip",
  "os",
  "role",
  "ssh",
  "syncthing",
  "rclone",
] as const;

/**
 * Emit a YAML document with top-level keys in the declared order.
 * Nested objects are emitted with alphabetic key order.
 * Indentation: 2 spaces. Flow style: never.
 */
export function canonicalEmit(value: unknown, topOrder: readonly string[]): string {
  const ordered = orderTop(value, topOrder);
  return stringify(ordered, {
    indent: 2,
    indentSeq: true,
    lineWidth: 0,
    minContentWidth: 0,
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
    sortMapEntries: false, // we did the ordering ourselves
  });
}

function orderTop(value: unknown, topOrder: readonly string[]): unknown {
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  // Declared keys first, in declared order.
  for (const k of topOrder) {
    if (k in value) out[k] = orderNested(value[k]);
  }
  // Any extra keys come after, alphabetically.
  const extra = Object.keys(value).filter((k) => !topOrder.includes(k)).sort();
  for (const k of extra) out[k] = orderNested(value[k]);
  return out;
}

function orderNested(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderNested);
  if (!isRecord(value)) return value;
  const keys = Object.keys(value).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = orderNested(value[k]);
  return out;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
