import { relative } from "node:path";
import { loadRuleset } from "./parse.ts";
import { resolveImport, type ResolveContext } from "./resolve.ts";
import { emitRcloneFilter, emitStignore } from "./emit.ts";
import { buildHeader } from "./header.ts";
import { CompileError, type CompileOptions, type CompileResult } from "./types.ts";

const SYNCTHING_ONLY_RE = /\((?:\?d|\?i)\)/;
const RCLONE_ONLY_RE = /\{[^}]+,[^}]+\}/;

export function compile(rulesetPath: string, opts: CompileOptions): CompileResult {
  const root = loadRuleset(rulesetPath);

  const ctx: ResolveContext = {
    rulesetsDir: opts.rulesetsDir,
    importsDir: opts.importsDir,
    rulesetPath,
    visited: new Set([rulesetPath]),
  };

  const patterns: string[] = [];
  for (const imp of root.imports ?? []) patterns.push(...resolveImport(imp, ctx));
  for (const ex of root.excludes ?? []) patterns.push(ex);
  for (const inc of root.includes ?? []) patterns.push(inc);

  const warnings = detectDivergence(patterns);
  if (warnings.length > 0 && !opts.allowDivergent) {
    throw new CompileError(
      `engine divergence detected (pass allowDivergent: true to override):\n  ${warnings.join("\n  ")}`,
    );
  }

  const header = buildHeader({
    sourceRelPath: relative(opts.rulesetsDir, rulesetPath).split("\\").join("/"),
    commitSha: opts.commitSha ?? "local",
    generatedAt: opts.now ?? new Date(),
  });

  const stExtra = root.engine_overrides?.syncthing?.extra ?? [];
  const rcExtra = root.engine_overrides?.rclone?.extra ?? [];

  return {
    stignore: emitStignore(patterns, stExtra, header),
    rcloneFilter: emitRcloneFilter(patterns, rcExtra, header),
    warnings,
    source: rulesetPath,
  };
}

function detectDivergence(patterns: string[]): string[] {
  const out: string[] = [];
  for (const p of patterns) {
    if (SYNCTHING_ONLY_RE.test(p)) {
      out.push(`Syncthing-only syntax in pattern "${p}" — rclone won't understand the (?d)/(?i) prefix.`);
    }
    if (RCLONE_ONLY_RE.test(p)) {
      out.push(`rclone-only brace expansion in pattern "${p}" — Syncthing's .stignore doesn't expand braces.`);
    }
  }
  return out;
}
