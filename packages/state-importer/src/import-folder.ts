import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { SyncthingClient, SyncthingError } from "@synccenter/adapters/syncthing";
import { canonicalEmit, FOLDER_KEY_ORDER } from "./canonical.ts";
import { unifiedDiff } from "./diff.ts";
import { matchRuleset } from "./ruleset-match.ts";
import { ImportError } from "./errors.ts";
import type { ImportOpts, ImportResult } from "./types.ts";

export async function importFolder(name: string, opts: ImportOpts): Promise<ImportResult> {
  const paths: Record<string, string> = {};
  const folderTypes = new Set<string>();
  let ignoreLines: string[] | null = null;
  let foundOnAnyHost = false;

  for (const host of opts.hosts) {
    const client = new SyncthingClient({ baseUrl: host.apiUrl, apiKey: host.apiKey, fetch: opts.fetch });
    let folder;
    try {
      folder = await client.getFolder(name);
    } catch (err) {
      if (err instanceof SyncthingError && err.status === 404) continue;
      throw new ImportError(`failed to query ${host.name}: ${(err as Error).message}`, "HOST_UNREACHABLE", err);
    }
    if (!folder || !folder.id) continue;
    foundOnAnyHost = true;
    paths[host.name] = folder.path;
    folderTypes.add(folder.type);
    if (ignoreLines === null) {
      try {
        const ig = await client.getIgnores(name);
        ignoreLines = ig.ignore ?? [];
      } catch (err) {
        throw new ImportError(
          `failed to read ignores from ${host.name}: ${(err as Error).message}`,
          "HOST_UNREACHABLE",
          err,
        );
      }
    }
  }

  if (!foundOnAnyHost) {
    throw new ImportError(`folder ${name} not present on any configured host`, "FOLDER_NOT_PRESENT_ANYWHERE");
  }

  const ruleset = resolveRuleset(opts.configDir, ignoreLines ?? []);
  const type = pickFolderType(folderTypes);

  const proposed = {
    name,
    ruleset,
    type,
    paths,
  };

  const yaml = canonicalEmit(proposed, FOLDER_KEY_ORDER);
  const target = join(opts.configDir, "folders", `${name}.yaml`);
  return writeOrDiff(target, yaml, { kind: "folder", name }, opts.write);
}

function pickFolderType(
  types: Set<string>,
): "send-receive" | "send-only" | "receive-only" | "receive-encrypted" {
  // Syncthing wire: "sendreceive" / "sendonly" / "receiveonly" / "receiveencrypted".
  // Manifest enum uses hyphenated forms. Prefer the most permissive when hosts differ.
  const norm = [...types].map((t) =>
    t === "sendreceive"
      ? "send-receive"
      : t === "sendonly"
        ? "send-only"
        : t === "receiveonly"
          ? "receive-only"
          : t === "receiveencrypted"
            ? "receive-encrypted"
            : "send-receive",
  );
  if (norm.includes("send-receive")) return "send-receive";
  if (norm.includes("send-only")) return "send-only";
  if (norm.includes("receive-only")) return "receive-only";
  return "receive-encrypted";
}

function resolveRuleset(configDir: string, ignoreLines: string[]): string {
  const compiledDir = join(configDir, "compiled");
  if (!existsSync(compiledDir)) return "imported";
  const known: Record<string, string[]> = {};
  for (const d of readdirSync(compiledDir)) {
    const p = join(compiledDir, d, ".stignore");
    if (!existsSync(p)) continue;
    known[d] = readFileSync(p, "utf8").split(/\r?\n/);
  }
  const match = matchRuleset(ignoreLines, known);
  return match ?? "imported";
}

function writeOrDiff(
  target: string,
  proposed: string,
  resource: ImportResult["resource"],
  write: boolean | undefined,
): ImportResult {
  const onDisk = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (onDisk === proposed) {
    return { resource, path: target, status: "identical" };
  }
  const diff = unifiedDiff(onDisk, proposed, target);
  if (!write) {
    return { resource, path: target, status: "would-change", diff };
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, proposed, "utf8");
  return { resource, path: target, status: "written", diff };
}
