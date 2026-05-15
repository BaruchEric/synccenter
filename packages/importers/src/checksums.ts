import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChecksumEntry, ChecksumFile } from "./types.ts";

const FILENAME = "checksums.json";

export function loadChecksums(importsDir: string): ChecksumFile {
  const path = join(importsDir, FILENAME);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { version: 1, entries: [] };
  }
  try {
    const parsed = JSON.parse(raw) as ChecksumFile;
    if (parsed.version !== 1) return { version: 1, entries: [] };
    return parsed;
  } catch {
    return { version: 1, entries: [] };
  }
}

export function saveChecksums(importsDir: string, file: ChecksumFile): void {
  const path = join(importsDir, FILENAME);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
}

export function upsertEntry(file: ChecksumFile, entry: ChecksumEntry): ChecksumFile {
  const others = file.entries.filter((e) => e.uri !== entry.uri);
  return { version: 1, entries: [...others, entry].sort((a, b) => a.uri.localeCompare(b.uri)) };
}

export function findEntry(file: ChecksumFile, uri: string): ChecksumEntry | undefined {
  return file.entries.find((e) => e.uri === uri);
}
