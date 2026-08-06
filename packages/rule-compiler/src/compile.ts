import { relative } from "node:path";
import { loadRuleset } from "./parse.ts";
import { resolveImport, type ResolveContext } from "./resolve.ts";
import { emitRcloneFilter, emitStignore, findFatalBrackets } from "./emit.ts";
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
  // Last in gitignore order => first in both emitted (reversed) artifacts, so
  // these outrank every re-include above. See Ruleset.hard_excludes.
  for (const hx of root.hard_excludes ?? []) patterns.push(hx);

  const stExtra = root.engine_overrides?.syncthing?.extra ?? [];
  const rcExtra = root.engine_overrides?.rclone?.extra ?? [];

  // Deliberately NOT gated on allowDivergent. Divergence is a trade-off an
  // operator can knowingly accept; a class Syncthing cannot parse is not — it
  // discards the whole .stignore, so the folder syncs with no ignores at all
  // and nothing in the sync itself looks wrong. Refusing to emit is the only
  // safe answer. rclone-only extras are exempt: they never reach .stignore.
  const fatal = [...patterns, ...stExtra].flatMap(findFatalBrackets);
  if (fatal.length > 0) {
    throw new CompileError(
      `pattern(s) Syncthing's glob engine cannot parse — emitting them would make it ` +
        `discard the ENTIRE .stignore and sync with NO ignores:\n  ${fatal.join("\n  ")}`,
    );
  }

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
