import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_ALLOWLIST = ["raw.githubusercontent.com"];

/** Read importsDir/allowlist.txt and merge with the defaults. */
export function loadAllowlist(importsDir: string, extras?: string[]): string[] {
  const fromFile = readAllowlistFile(join(importsDir, "allowlist.txt"));
  return Array.from(new Set([...DEFAULT_ALLOWLIST, ...fromFile, ...(extras ?? [])]));
}

function readAllowlistFile(path: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

export function isHostAllowed(host: string, allowlist: string[]): boolean {
  return allowlist.includes(host);
}
