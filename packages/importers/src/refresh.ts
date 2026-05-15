import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isHostAllowed, loadAllowlist } from "./allowlist.ts";
import { findEntry, loadChecksums, saveChecksums, upsertEntry } from "./checksums.ts";
import { parseImportUri } from "./parse.ts";
import { scanRulesetImports } from "./scan.ts";
import { ImporterError, type ParsedImport, type RefreshOpts, type RefreshResult } from "./types.ts";

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const GITHUB_RAW = "https://raw.githubusercontent.com/github/gitignore/main";

export async function refreshAll(opts: RefreshOpts): Promise<RefreshResult[]> {
  const { imports } = scanRulesetImports(opts.rulesetsDir);
  // Serial — each refreshOne reads/writes checksums.json. Parallel fetches
  // would race on the single-file write and lose all but the last entry.
  const results: RefreshResult[] = [];
  for (const uri of imports) {
    results.push(await refreshOne(uri, opts));
  }
  return results;
}

export async function refreshOne(uri: string, opts: RefreshOpts): Promise<RefreshResult> {
  let parsed: ParsedImport;
  try {
    parsed = parseImportUri(uri);
  } catch (err) {
    return { uri, status: "error-fetch", error: (err as Error).message };
  }

  if (parsed.scheme === "ruleset") {
    // No fetch needed — just verify the target ruleset exists.
    const target = join(opts.rulesetsDir, `${parsed.rulesetName!}.yaml`);
    return existsSync(target)
      ? { uri, status: "skipped-not-cacheable" }
      : { uri, status: "skipped-missing-local", error: `ruleset not found: ${parsed.rulesetName}` };
  }

  if (parsed.scheme === "file") {
    const target = parsed.filePath!;
    return existsSync(target)
      ? { uri, status: "skipped-not-cacheable" }
      : { uri, status: "skipped-missing-local", error: `file not found: ${target}` };
  }

  if (parsed.scheme === "github") return refreshGithub(uri, parsed, opts);
  if (parsed.scheme === "url") return refreshUrl(uri, parsed, opts);

  return { uri, status: "error-fetch", error: "unreachable" };
}

async function refreshGithub(uri: string, parsed: ParsedImport, opts: RefreshOpts): Promise<RefreshResult> {
  const name = parsed.githubName!;
  const remoteUrl = `${GITHUB_RAW}/${name}.gitignore`;
  const cachePath = join("github-gitignore", `${name}.gitignore`);
  return fetchAndCache(uri, remoteUrl, cachePath, opts);
}

async function refreshUrl(uri: string, parsed: ParsedImport, opts: RefreshOpts): Promise<RefreshResult> {
  const allowlist = opts.allowlist ?? loadAllowlist(opts.importsDir);
  const url = new URL(parsed.url!);
  if (!isHostAllowed(url.hostname, allowlist)) {
    return {
      uri,
      status: "error-allowlist",
      error: `host ${url.hostname} not in allowlist (${allowlist.join(", ")})`,
    };
  }
  const sha = createHash("sha256").update(uri).digest("hex");
  const tail = url.pathname.split("/").pop() || "content";
  const cachePath = join("url-cache", sha, tail);
  return fetchAndCache(uri, parsed.url!, cachePath, opts);
}

async function fetchAndCache(
  uri: string,
  remoteUrl: string,
  cachePathRel: string,
  opts: RefreshOpts,
): Promise<RefreshResult> {
  const now = opts.now ?? new Date();
  const maxAge = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const checksums = loadChecksums(opts.importsDir);
  const existing = findEntry(checksums, uri);
  const absPath = join(opts.importsDir, cachePathRel);

  if (!opts.force && existing && existsSync(absPath)) {
    const age = now.getTime() - new Date(existing.fetchedAt).getTime();
    if (age < maxAge) {
      return {
        uri,
        status: "cached",
        cachePath: cachePathRel,
        sha256: existing.sha256,
        bytes: existing.bytes,
        fetchedAt: existing.fetchedAt,
      };
    }
  }

  const fetchImpl = opts.fetch ?? globalThis.fetch;
  let body: string;
  try {
    const res = await fetchImpl(remoteUrl);
    if (!res.ok) {
      return { uri, status: "error-fetch", error: `${res.status} ${res.statusText} for ${remoteUrl}` };
    }
    body = await res.text();
  } catch (err) {
    return { uri, status: "error-fetch", error: (err as Error).message };
  }

  try {
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, body);
  } catch (err) {
    return { uri, status: "error-write", error: (err as Error).message };
  }

  const sha256 = createHash("sha256").update(body).digest("hex");
  const fetchedAt = now.toISOString();
  const entry = { uri, sha256, bytes: Buffer.byteLength(body, "utf8"), fetchedAt, cachePath: cachePathRel };
  saveChecksums(opts.importsDir, upsertEntry(checksums, entry));

  return { uri, status: "fetched", cachePath: cachePathRel, sha256, bytes: entry.bytes, fetchedAt };
}

export { ImporterError };
