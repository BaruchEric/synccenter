import { ImportError } from "./errors.ts";

/**
 * Given a list of live ignore lines and a map of known ruleset name → compiled pattern array,
 * return the ruleset whose set-of-patterns matches the live set, or null.
 *
 * Live lines may include header comments and blank lines from compiled .stignore output;
 * those are stripped before comparing.
 *
 * Throws ImportError(RULESET_AMBIGUOUS) when two or more known rulesets match identically.
 */
export function matchRuleset(live: string[], known: Record<string, string[]>): string | null {
  const liveSet = normalize(live);
  const matches: string[] = [];
  for (const [name, patterns] of Object.entries(known)) {
    if (eqSet(liveSet, normalize(patterns))) matches.push(name);
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new ImportError(
      `RULESET_AMBIGUOUS: live ignores match multiple known rulesets: ${matches.join(", ")}`,
      "RULESET_AMBIGUOUS",
    );
  }
  return matches[0]!;
}

function normalize(lines: string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of lines) {
    const line = raw.replace(/^﻿/, "").trim();
    if (line === "" || line.startsWith("#")) continue;
    out.add(line);
  }
  return out;
}

function eqSet<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
