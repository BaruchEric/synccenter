import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { parseImportUri, type ParsedImport } from "@synccenter/importers";
import { CompileError } from "./types.ts";
import { loadRuleset } from "./parse.ts";

export interface ResolveContext {
  rulesetsDir: string;
  importsDir: string;
  rulesetPath: string;
  visited: Set<string>;
}

export function resolveImport(uri: string, ctx: ResolveContext): string[] {
  let parsed: ParsedImport;
  try {
    parsed = parseImportUri(uri);
  } catch (err) {
    throw new CompileError(err instanceof Error ? err.message : String(err), err);
  }

  switch (parsed.scheme) {
    case "github":
      return loadGithub(parsed.githubName!, ctx);
    case "file":
      return loadFile(parsed.filePath!, ctx);
    case "ruleset":
      return loadRulesetImport(parsed.rulesetName!, ctx);
    case "url":
      return loadUrlCache(parsed.url!, uri, ctx);
  }
}

function loadGithub(name: string, ctx: ResolveContext): string[] {
  const path = join(ctx.importsDir, "github-gitignore", `${name}.gitignore`);
  return readPatternsFile(path, `github://github/gitignore/${name}`);
}

function loadFile(rest: string, ctx: ResolveContext): string[] {
  const path = isAbsolute(rest) ? rest : resolvePath(dirname(ctx.rulesetPath), rest);
  return readPatternsFile(path, `file://${rest}`);
}

function loadRulesetImport(name: string, ctx: ResolveContext): string[] {
  const path = join(ctx.rulesetsDir, `${name}.yaml`);
  if (ctx.visited.has(path)) {
    throw new CompileError(`circular ruleset import: ${name} (chain: ${[...ctx.visited].join(" -> ")})`);
  }
  ctx.visited.add(path);
  const child = loadRuleset(path);
  const childCtx: ResolveContext = { ...ctx, rulesetPath: path };
  const out: string[] = [];
  for (const imp of child.imports ?? []) out.push(...resolveImport(imp, childCtx));
  for (const ex of child.excludes ?? []) out.push(ex);
  for (const inc of child.includes ?? []) out.push(inc);
  ctx.visited.delete(path);
  return out;
}

function loadUrlCache(url: string, originalUri: string, ctx: ResolveContext): string[] {
  // Cache lookup only — fetching is the gitignore-importer's job.
  const sha = createHash("sha256").update(originalUri).digest("hex");
  const dir = join(ctx.importsDir, "url-cache", sha);
  const tail = new URL(url).pathname.split("/").pop() || "content";
  const path = join(dir, tail);
  return readPatternsFile(path, originalUri);
}

function readPatternsFile(path: string, sourceLabel: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new CompileError(
      `import not cached locally: ${sourceLabel} (expected at ${path}). Run the gitignore-importer agent first.`,
      cause,
    );
  }
  return normalizePatterns(raw);
}

export function normalizePatterns(raw: string): string[] {
  const out: string[] = [];
  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = lineRaw.replace(/^﻿/, ""); // strip BOM
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    out.push(line.replace(/\s+$/, "").replace(/\\/g, "/"));
  }
  return out;
}
