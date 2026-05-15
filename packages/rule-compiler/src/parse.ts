import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { CompileError, type Ruleset } from "./types.ts";

export function loadRuleset(path: string): Ruleset {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new CompileError(`cannot read ruleset: ${path}`, cause);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (cause) {
    throw new CompileError(`invalid YAML in ${path}`, cause);
  }

  return validate(parsed, path);
}

function validate(raw: unknown, path: string): Ruleset {
  if (!isRecord(raw)) {
    throw new CompileError(`ruleset must be a YAML object (in ${path})`);
  }

  const name = raw.name;
  if (typeof name !== "string" || !/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new CompileError(`ruleset.name must be lowercase kebab-case (in ${path})`);
  }

  const version = raw.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new CompileError(`ruleset.version must be a positive integer (in ${path})`);
  }

  const r: Ruleset = { name, version };

  if (typeof raw.description === "string") r.description = raw.description;
  if (Array.isArray(raw.imports)) r.imports = raw.imports.map((x) => asString(x, "imports[]", path));
  if (Array.isArray(raw.excludes)) r.excludes = raw.excludes.map((x) => asString(x, "excludes[]", path));
  if (Array.isArray(raw.includes)) {
    r.includes = raw.includes.map((x) => {
      const s = asString(x, "includes[]", path);
      if (!s.startsWith("!")) {
        throw new CompileError(`includes[] entries must start with '!' (got "${s}" in ${path})`);
      }
      return s;
    });
  }

  if (isRecord(raw.engine_overrides)) {
    const eo: Ruleset["engine_overrides"] = {};
    const st = raw.engine_overrides.syncthing;
    const rc = raw.engine_overrides.rclone;
    if (isRecord(st) && Array.isArray(st.extra)) {
      eo.syncthing = { extra: st.extra.map((x) => asString(x, "engine_overrides.syncthing.extra[]", path)) };
    }
    if (isRecord(rc) && Array.isArray(rc.extra)) {
      const extra = rc.extra.map((x) => asString(x, "engine_overrides.rclone.extra[]", path));
      for (const line of extra) {
        if (!/^[+-] /.test(line)) {
          throw new CompileError(
            `engine_overrides.rclone.extra[] entries must start with '+ ' or '- ' (got "${line}" in ${path})`,
          );
        }
      }
      eo.rclone = { extra };
    }
    if (eo.syncthing || eo.rclone) r.engine_overrides = eo;
  }

  return r;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function asString(x: unknown, ctx: string, path: string): string {
  if (typeof x !== "string") {
    throw new CompileError(`${ctx} must be a string (in ${path})`);
  }
  return x;
}
