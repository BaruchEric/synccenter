import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { CompileError } from "./types.ts";
import { loadRuleset } from "./parse.ts";

export interface ResolveContext {
  rulesetsDir: string;
  importsDir: string;
  rulesetPath: string;
  visited: Set<string>;
}

export function resolveImport(uri: string, ctx: ResolveContext): string[] {
  const m = /^(github|file|ruleset|url):\/\/(.+)$/.exec(uri);
  if (!m) throw new CompileError(`unsupported import URI: ${uri}`);
  const scheme = m[1] as "github" | "file" | "ruleset" | "url";
  const rest = m[2]!;

  switch (scheme) {
    case "github":
      return loadGithubGitignore(rest, ctx);
    case "file":
      return loadFile(rest, ctx);
    case "ruleset":
      return loadRulesetImport(rest, ctx);
    case "url":
      return loadUrlCache(rest, ctx);
  }
}

function loadGithubGitignore(rest: string, ctx: ResolveContext): string[] {
  const expected = /^github\/gitignore\/([A-Za-z0-9._-]+)$/.exec(rest);
  if (!expected) {
    throw new CompileError(`github:// imports must match 'github/gitignore/<NAME>' (got "${rest}")`);
  }
  const name = expected[1]!;
  const path = join(ctx.importsDir, "github-gitignore", `${name}.gitignore`);
  return readPatternsFile(path, `github://github/gitignore/${name}`);
}

function loadFile(rest: string, ctx: ResolveContext): string[] {
  const path = isAbsolute(rest) ? rest : resolvePath(dirname(ctx.rulesetPath), rest);
  return readPatternsFile(path, `file://${rest}`);
}

function loadRulesetImport(rest: string, ctx: ResolveContext): string[] {
  if (!/^[a-z][a-z0-9-]*$/.test(rest)) {
    throw new CompileError(`ruleset:// name must be lowercase kebab-case (got "${rest}")`);
  }
  const path = join(ctx.rulesetsDir, `${rest}.yaml`);
  if (ctx.visited.has(path)) {
    throw new CompileError(`circular ruleset import: ${rest} (chain: ${[...ctx.visited].join(" -> ")})`);
  }
  ctx.visited.add(path);
  const child = loadRuleset(path);
  // Recursively resolve imports of the child, then append child's own patterns.
  const childCtx: ResolveContext = { ...ctx, rulesetPath: path };
  const out: string[] = [];
  for (const imp of child.imports ?? []) out.push(...resolveImport(imp, childCtx));
  for (const ex of child.excludes ?? []) out.push(ex);
  for (const inc of child.includes ?? []) out.push(inc);
  ctx.visited.delete(path);
  return out;
}

function loadUrlCache(rest: string, ctx: ResolveContext): string[] {
  // Cache lookup only — fetching is gitignore-importer's job.
  const url = `url://${rest}`;
  const sha = createHash("sha256").update(url).digest("hex");
  const dir = join(ctx.importsDir, "url-cache", sha);
  // Resolve a deterministic filename: the URL's basename or "content".
  const tail = rest.split("/").pop() ?? "content";
  const path = join(dir, tail || "content");
  return readPatternsFile(path, url);
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
    // Preserve internal whitespace but trim trailing CR / whitespace.
    out.push(line.replace(/\s+$/, "").replace(/\\/g, "/"));
  }
  return out;
}
