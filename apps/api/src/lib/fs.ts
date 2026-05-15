import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { FolderManifest } from "../types.ts";

/** List the names (without `.yaml`) of every YAML file in `dir`. Returns [] on missing/unreadable dirs. */
export function listYamlNames(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".yaml"))
      .map((f) => basename(f, ".yaml"))
      .sort();
  } catch {
    return [];
  }
}

/** Parse one folder manifest from `<foldersDir>/<name>.yaml`. Returns undefined on read or parse failure. */
export function parseFolderByName(foldersDir: string, name: string): FolderManifest | undefined {
  return parseFolderFile(join(foldersDir, `${name}.yaml`));
}

/** Parse a folder manifest from a file path. Returns undefined on read or parse failure. */
export function parseFolderFile(path: string): FolderManifest | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = parseYaml(raw) as FolderManifest;
    if (parsed?.name && parsed.paths && typeof parsed.paths === "object") return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

/** List every folder manifest under `foldersDir` (skipping unparseable files). */
export function listFolderManifests(foldersDir: string): FolderManifest[] {
  const out: FolderManifest[] = [];
  let files: string[];
  try {
    files = readdirSync(foldersDir).filter((f) => f.endsWith(".yaml"));
  } catch {
    return out;
  }
  for (const f of files) {
    const m = parseFolderFile(join(foldersDir, f));
    if (m) out.push(m);
  }
  return out;
}
