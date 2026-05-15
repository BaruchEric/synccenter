import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface ScanResult {
  imports: string[];
  perRuleset: Record<string, string[]>;
}

/** Return every unique `imports:` entry across all rulesets in `rulesetsDir`. */
export function scanRulesetImports(rulesetsDir: string): ScanResult {
  let names: string[] = [];
  try {
    names = readdirSync(rulesetsDir).filter((f) => f.endsWith(".yaml"));
  } catch {
    return { imports: [], perRuleset: {} };
  }

  const perRuleset: Record<string, string[]> = {};
  const all = new Set<string>();

  for (const file of names) {
    let raw: string;
    try {
      raw = readFileSync(join(rulesetsDir, file), "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const imports = (parsed as { imports?: unknown }).imports;
    if (!Array.isArray(imports)) continue;
    const list = imports.filter((x): x is string => typeof x === "string");
    perRuleset[file.slice(0, -".yaml".length)] = list;
    for (const i of list) all.add(i);
  }

  return { imports: Array.from(all).sort(), perRuleset };
}
