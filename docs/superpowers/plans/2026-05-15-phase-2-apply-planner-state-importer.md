# Phase 2 Implementation Plan — apply-planner + state-importer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the manifest-compilation + reverse-import layer that turns committed `synccenter-config/folders/*.yaml` into Syncthing REST operations + rclone bisync schedule entries, and that captures live mesh state back into canonical YAML.

**Architecture:** Two new packages above the existing `rule-compiler`/`importers`/`adapters` layer. `packages/apply-planner` is the manifest compiler (pure `plan()` → typed `ApplyPlan`, side-effecting `apply()`/`verify()` via existing adapters, plus a crontab renderer). `packages/state-importer` reads live state via existing adapters and emits byte-deterministic canonical YAML, diff-by-default with `--write`. Schema fixes fold in along the way. CLI/API thin wrappers expose both.

**Tech Stack:**
- bun runtime, TypeScript strict mode (verbatimModuleSyntax, allowImportingTsExtensions)
- `yaml@^2.5.0` (already used in rule-compiler) — leverages `sortMapEntries` for canonical emit
- `ajv@^8` (new dep) for JSON Schema validation
- `bun:test` for unit tests, golden fixtures committed under `test/fixtures/` and `test/golden/`
- `Bun.spawnSync` for `sops -d --extract` shell-out
- `commander` (already used in `apps/cli`) for CLI
- `express` (already used in `apps/api`) for routes
- Workspace deps via `"@synccenter/<pkg>": "workspace:*"`

**Spec reference:** `docs/superpowers/specs/2026-05-15-phase-2-apply-planner-state-importer-design.md`

---

## File map

**Created:**

```
packages/apply-planner/
├── package.json
├── tsconfig.json
├── README.md
└── src/
    ├── index.ts
    ├── types.ts
    ├── errors.ts
    ├── load.ts
    ├── secrets.ts
    ├── plan.ts
    ├── conflict.ts
    ├── schedule.ts
    ├── render-crontab.ts
    ├── delta.ts
    ├── apply.ts
    └── verify.ts
└── test/
    ├── plan.test.ts
    ├── conflict.test.ts
    ├── render-crontab.test.ts
    ├── delta.test.ts
    ├── apply.test.ts
    ├── load.test.ts
    ├── secrets.test.ts
    ├── verify.test.ts
    ├── fixtures/
    │   ├── folders/ (committed copies of test.yaml + example-code-projects.yaml)
    │   ├── hosts/ (committed copies of all three host manifests)
    │   ├── rules/ (committed copies of base-binaries.yaml + dev-monorepo.yaml)
    │   └── compiled/ (committed copies of compiled rulesets)
    └── golden/
        ├── plan-test.json
        ├── plan-example-code-projects.json
        └── crontab-example-code-projects.cron

packages/state-importer/
├── package.json
├── tsconfig.json
├── README.md
└── src/
    ├── index.ts
    ├── types.ts
    ├── errors.ts
    ├── canonical.ts
    ├── ruleset-match.ts
    ├── diff.ts
    ├── import-folder.ts
    ├── import-host.ts
    └── import-all.ts
└── test/
    ├── canonical.test.ts
    ├── ruleset-match.test.ts
    ├── diff.test.ts
    ├── import-folder.test.ts
    ├── import-host.test.ts
    └── fixtures/
        ├── folders/ (committed copies, same as apply-planner fixtures)
        ├── hosts/
        └── compiled/
```

**Modified:**

```
packages/schema/host.schema.json        — extend syncthing.install_method enum, add binary_path/home_dir
packages/schema/folder.schema.json      — add conflict, overrides, cloud.anchor
apps/cli/src/commands/folders.ts        — add plan + apply subcommands
apps/cli/src/commands/state.ts          — NEW: import subcommands
apps/cli/src/commands/schedule.ts       — NEW: render subcommand
apps/cli/src/index.ts                   — register state + schedule commands
apps/cli/package.json                   — depend on @synccenter/apply-planner + state-importer
apps/api/src/routes/folders.ts          — add /plan + /apply endpoints
apps/api/src/routes/state.ts            — NEW: /state/import/* endpoints
apps/api/src/routes/schedule.ts         — NEW: /schedule/crontab endpoint
apps/api/src/app.ts                     — register state + schedule routers
apps/api/package.json                   — depend on @synccenter/apply-planner + state-importer
```

**Modified in `synccenter-config/`:**

```
hosts/qnap-ts453d.yaml                  — add role: cloud-edge
```

---

## Conventions used by all tasks

- **TS imports** use `.ts` extension and `import type { ... }` for type-only.
- **Test files** import from `bun:test`: `import { describe, it, expect, beforeEach, afterEach } from "bun:test";`.
- **Commit format** matches existing repo style (lower-case, colon-separated): `phase-2: <description>`.
- **Run a test:** `bun test packages/<pkg>/test/<name>.test.ts`. Run all tests in a package: `bun test --cwd packages/<pkg>`.
- **Typecheck a package:** `bun run --filter @synccenter/<pkg> typecheck`.
- **Golden file update sentinel:** tests honor `BUN_UPDATE_GOLDEN=1` (writes new golden) but otherwise compare and fail.

---

### Task 1: Extend host.schema.json for Windows install method

**Files:**
- Modify: `packages/schema/host.schema.json`

- [ ] **Step 1: Modify `install_method` enum and add Windows-specific fields**

Edit `packages/schema/host.schema.json` — in the `properties.syncthing.properties` object:

```json
"install_method": {
  "type": "string",
  "enum": ["brew", "docker", "qpkg", "synctrayzor", "winget+nssm"]
},
"binary_path": {
  "type": "string",
  "description": "Absolute path to the Syncthing binary. Required for winget+nssm installs."
},
"home_dir": {
  "type": "string",
  "description": "Absolute path to Syncthing's config + database directory. Required for winget+nssm installs."
},
```

- [ ] **Step 2: Verify the existing `synccenter-config/hosts/win-desktop.yaml` now matches the schema**

Run:
```bash
cd /Users/ericbaruch/Arik/dev/synccenter && bun -e '
import Ajv from "ajv";
import { readFileSync } from "fs";
import { parse } from "yaml";
const ajv = new Ajv({ strict: false });
const schema = JSON.parse(readFileSync("packages/schema/host.schema.json", "utf8"));
const validate = ajv.compile(schema);
const doc = parse(readFileSync("/Users/ericbaruch/Arik/dev/synccenter-config/hosts/win-desktop.yaml", "utf8"));
console.log(validate(doc) ? "OK" : JSON.stringify(validate.errors, null, 2));
'
```
Expected: `OK`

If ajv isn't installed yet at root, install: `bun add -d ajv@^8 yaml@^2.5` (root devDep is fine for this one-off).

- [ ] **Step 3: Commit**

```bash
git add packages/schema/host.schema.json
git commit -m "phase-2: extend host schema for winget+nssm install_method"
```

---

### Task 2: Extend folder.schema.json with conflict, overrides, cloud.anchor

**Files:**
- Modify: `packages/schema/folder.schema.json`

- [ ] **Step 1: Add the three new optional fields**

In `properties`, add a `conflict` block:

```json
"conflict": {
  "type": "object",
  "additionalProperties": false,
  "description": "Folder-wide conflict resolution policy. Compiler maps policy to engine-specific flags.",
  "properties": {
    "policy": {
      "type": "string",
      "enum": ["newer", "older", "keep-both", "require-resolve"]
    },
    "surface_to_ui": { "type": "boolean", "default": true }
  }
},
"overrides": {
  "type": "object",
  "description": "Per-host scalar overrides for fields that may legitimately differ per host (type, ignore_perms, fs_watcher_*, versioning).",
  "additionalProperties": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "type": { "type": "string", "enum": ["send-receive", "send-only", "receive-only", "receive-encrypted"] },
      "ignore_perms": { "type": "boolean" },
      "fs_watcher_enabled": { "type": "boolean" },
      "fs_watcher_delay_s": { "type": "integer", "minimum": 1, "maximum": 3600 },
      "versioning": { "$ref": "#/properties/versioning" }
    }
  },
  "propertyNames": { "pattern": "^[a-z][a-z0-9-]*$" }
},
```

Inside `cloud` properties, add:

```json
"anchor": {
  "type": "string",
  "pattern": "^[a-z][a-z0-9-]*$",
  "description": "Optional host name override for the bisync anchor. Default: the unique host with role: cloud-edge."
}
```

- [ ] **Step 2: Verify existing `synccenter-config/folders/*.yaml` still validate**

```bash
cd /Users/ericbaruch/Arik/dev/synccenter && bun -e '
import Ajv from "ajv";
import { readFileSync, readdirSync } from "fs";
import { parse } from "yaml";
const ajv = new Ajv({ strict: false });
const schema = JSON.parse(readFileSync("packages/schema/folder.schema.json", "utf8"));
const validate = ajv.compile(schema);
const dir = "/Users/ericbaruch/Arik/dev/synccenter-config/folders";
for (const f of readdirSync(dir).filter(f => f.endsWith(".yaml"))) {
  const doc = parse(readFileSync(`${dir}/${f}`, "utf8"));
  console.log(f, validate(doc) ? "OK" : JSON.stringify(validate.errors, null, 2));
}
'
```
Expected: every file prints `OK`.

- [ ] **Step 3: Commit**

```bash
git add packages/schema/folder.schema.json
git commit -m "phase-2: extend folder schema with conflict, overrides, cloud.anchor"
```

---

### Task 3: Add role: cloud-edge to qnap-ts453d host manifest

**Files:**
- Modify: `/Users/ericbaruch/Arik/dev/synccenter-config/hosts/qnap-ts453d.yaml`

- [ ] **Step 1: Add the role field**

In `synccenter-config/hosts/qnap-ts453d.yaml`, ensure the top-level has:

```yaml
role: cloud-edge
```

(If `role` is already set to `mesh-node` or `hub`, change it to `cloud-edge`.)

- [ ] **Step 2: Verify the file still validates against host.schema.json**

```bash
cd /Users/ericbaruch/Arik/dev/synccenter && bun -e '
import Ajv from "ajv";
import { readFileSync } from "fs";
import { parse } from "yaml";
const ajv = new Ajv({ strict: false });
const schema = JSON.parse(readFileSync("packages/schema/host.schema.json", "utf8"));
const validate = ajv.compile(schema);
const doc = parse(readFileSync("/Users/ericbaruch/Arik/dev/synccenter-config/hosts/qnap-ts453d.yaml", "utf8"));
console.log(validate(doc) ? "OK" : JSON.stringify(validate.errors, null, 2));
console.log("role:", doc.role);
'
```
Expected: `OK` and `role: cloud-edge`.

- [ ] **Step 3: Commit in the config repo**

```bash
cd /Users/ericbaruch/Arik/dev/synccenter-config
git add hosts/qnap-ts453d.yaml
git commit -m "phase-2: mark qnap-ts453d as role: cloud-edge"
cd /Users/ericbaruch/Arik/dev/synccenter
```

---

### Task 4: Create state-importer package skeleton

**Files:**
- Create: `packages/state-importer/package.json`
- Create: `packages/state-importer/tsconfig.json`
- Create: `packages/state-importer/README.md`
- Create: `packages/state-importer/src/index.ts`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "@synccenter/state-importer",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "build": "echo 'state-importer: bundle in phase 3'"
  },
  "dependencies": {
    "@synccenter/adapters": "workspace:*",
    "@synccenter/schema": "workspace:*",
    "yaml": "^2.5.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "." },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Write `README.md`**

```markdown
# packages/state-importer

Reverse importer: live Syncthing/rclone state → canonical YAML manifests.

Owned by Phase 2. Used both at first-import (bootstrap from a hand-configured mesh) and for drift remediation (capture live changes into YAML before re-applying).

## Operations

- `importFolder(name, opts)` — read a folder's config + ignores from every host in `hosts/` that has it. Emit a `folders/<name>.yaml` matching the manifest schema.
- `importHost(name, opts)` — read `/rest/config/devices` + system info from the host's Syncthing API. Emit a `hosts/<name>.yaml` matching the host schema.
- `importAll(opts)` — every folder discovered on any host, plus every host already declared.

## Diff-by-default

Each operation produces canonical YAML, compares to the on-disk file, and:

- byte-identical → exits with `status: "identical"`, no write
- different + no `--write` → returns the unified diff with `status: "would-change"`, exits non-zero
- different + `--write` → writes the new content, returns `status: "written"`

Idempotency is structural: same live state always emits byte-identical YAML.
```

- [ ] **Step 4: Write empty `src/index.ts` placeholder**

```ts
// Public surface fills in as modules land.
export {};
```

- [ ] **Step 5: Install deps and run typecheck**

```bash
cd /Users/ericbaruch/Arik/dev/synccenter && bun install
bun run --filter @synccenter/state-importer typecheck
```
Expected: no output (typecheck passes on empty index).

- [ ] **Step 6: Commit**

```bash
git add packages/state-importer/
git commit -m "phase-2: state-importer package skeleton"
```

---

### Task 5: state-importer types + errors

**Files:**
- Create: `packages/state-importer/src/types.ts`
- Create: `packages/state-importer/src/errors.ts`
- Modify: `packages/state-importer/src/index.ts`

- [ ] **Step 1: Write `src/types.ts`**

```ts
export type ResourceKind = "folder" | "host";

export interface ImportResource {
  kind: ResourceKind;
  name: string;
}

export type ImportStatus = "identical" | "would-change" | "written";

export interface ImportResult {
  resource: ImportResource;
  path: string;
  status: ImportStatus;
  diff?: string;
}

export interface HostInfo {
  name: string;
  apiUrl: string;
  apiKey: string;
}

export interface ImportOpts {
  configDir: string;
  hosts: HostInfo[];
  write?: boolean;
  fetch?: typeof fetch;
}
```

- [ ] **Step 2: Write `src/errors.ts`**

```ts
export type ImportErrorCode =
  | "HOST_UNREACHABLE"
  | "FOLDER_NOT_PRESENT_ANYWHERE"
  | "RULESET_AMBIGUOUS"
  | "WRITE_BLOCKED";

export class ImportError extends Error {
  override readonly cause: unknown;
  constructor(
    message: string,
    public readonly code: ImportErrorCode,
    cause?: unknown,
  ) {
    super(message);
    this.name = "ImportError";
    this.cause = cause;
  }
}
```

- [ ] **Step 3: Update `src/index.ts`**

```ts
export type { ImportResult, ImportResource, ImportStatus, HostInfo, ImportOpts } from "./types.ts";
export { ImportError } from "./errors.ts";
```

- [ ] **Step 4: Typecheck**

```bash
bun run --filter @synccenter/state-importer typecheck
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/state-importer/src/
git commit -m "phase-2: state-importer types + errors"
```

---

### Task 6: Canonical YAML emit

**Files:**
- Create: `packages/state-importer/src/canonical.ts`
- Create: `packages/state-importer/test/canonical.test.ts`
- Modify: `packages/state-importer/src/index.ts`

- [ ] **Step 1: Write the failing test in `test/canonical.test.ts`**

```ts
import { describe, it, expect } from "bun:test";
import { parse } from "yaml";
import { canonicalEmit, FOLDER_KEY_ORDER, HOST_KEY_ORDER } from "../src/canonical.ts";

describe("canonicalEmit", () => {
  it("emits folder fields in schema order regardless of input key order", () => {
    const input = {
      paths: { "mac-studio": "/a", "qnap-ts453d": "/b" },
      type: "send-receive",
      ruleset: "dev-monorepo",
      name: "code",
    };
    const out = canonicalEmit(input, FOLDER_KEY_ORDER);
    const lines = out.split("\n").filter((l) => /^[a-z]/.test(l));
    expect(lines).toEqual([
      "name: code",
      "ruleset: dev-monorepo",
      "type: send-receive",
      "paths:",
    ]);
  });

  it("emits host fields in schema order", () => {
    const input = {
      syncthing: { install_method: "brew", api_url: "x", api_key_ref: "y", device_id_ref: "z" },
      os: "macos",
      role: "mesh-node",
      hostname: "mac.local",
      name: "mac-studio",
    };
    const out = canonicalEmit(input, HOST_KEY_ORDER);
    const lines = out.split("\n").filter((l) => /^[a-z]/.test(l));
    expect(lines).toEqual([
      "name: mac-studio",
      "hostname: mac.local",
      "os: macos",
      "role: mesh-node",
      "syncthing:",
    ]);
  });

  it("round-trips: parse(canonicalEmit(parse(x))) deepEquals parse(x)", () => {
    const yaml = `name: code\nruleset: dev-monorepo\ntype: send-receive\npaths:\n  mac-studio: /a\n  qnap-ts453d: /b\nignore_perms: true\n`;
    const data = parse(yaml);
    const reEmitted = canonicalEmit(data, FOLDER_KEY_ORDER);
    expect(parse(reEmitted)).toEqual(data);
  });

  it("is stable across two emits (no drift)", () => {
    const data = { name: "x", ruleset: "y", type: "send-receive", paths: { a: "/p" } };
    const first = canonicalEmit(data, FOLDER_KEY_ORDER);
    const second = canonicalEmit(parse(first), FOLDER_KEY_ORDER);
    expect(first).toBe(second);
  });

  it("uses 2-space indent and no flow style for sequences", () => {
    const data = { name: "x", excludes: ["a", "b", "c"] };
    const out = canonicalEmit(data, ["name", "excludes"]);
    expect(out).toContain("excludes:\n  - a\n  - b\n  - c\n");
    expect(out).not.toContain("["); // no flow style
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
bun test packages/state-importer/test/canonical.test.ts
```
Expected: fails with "cannot find module '../src/canonical.ts'".

- [ ] **Step 3: Implement `src/canonical.ts`**

```ts
import { stringify } from "yaml";

export const FOLDER_KEY_ORDER = [
  "name",
  "ruleset",
  "type",
  "paths",
  "cloud",
  "conflict",
  "versioning",
  "overrides",
  "ignore_perms",
  "fs_watcher_enabled",
  "fs_watcher_delay_s",
] as const;

export const HOST_KEY_ORDER = [
  "name",
  "hostname",
  "ip",
  "os",
  "role",
  "ssh",
  "syncthing",
  "rclone",
] as const;

/**
 * Emit a YAML document with top-level keys in the declared order.
 * Nested objects are emitted with alphabetic key order.
 * Indentation: 2 spaces. Flow style: never.
 */
export function canonicalEmit(value: unknown, topOrder: readonly string[]): string {
  const ordered = orderTop(value, topOrder);
  return stringify(ordered, {
    indent: 2,
    indentSeq: true,
    lineWidth: 0,
    minContentWidth: 0,
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
    sortMapEntries: false, // we did the ordering ourselves
  });
}

function orderTop(value: unknown, topOrder: readonly string[]): unknown {
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  // Declared keys first, in declared order.
  for (const k of topOrder) {
    if (k in value) out[k] = orderNested(value[k]);
  }
  // Any extra keys come after, alphabetically.
  const extra = Object.keys(value).filter((k) => !topOrder.includes(k)).sort();
  for (const k of extra) out[k] = orderNested(value[k]);
  return out;
}

function orderNested(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderNested);
  if (!isRecord(value)) return value;
  const keys = Object.keys(value).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = orderNested(value[k]);
  return out;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
```

- [ ] **Step 4: Run the test and verify pass**

```bash
bun test packages/state-importer/test/canonical.test.ts
```
Expected: all 5 tests pass.

- [ ] **Step 5: Update `src/index.ts` exports**

```ts
export { canonicalEmit, FOLDER_KEY_ORDER, HOST_KEY_ORDER } from "./canonical.ts";
export type { ImportResult, ImportResource, ImportStatus, HostInfo, ImportOpts } from "./types.ts";
export { ImportError } from "./errors.ts";
```

- [ ] **Step 6: Typecheck + commit**

```bash
bun run --filter @synccenter/state-importer typecheck
git add packages/state-importer/
git commit -m "phase-2: state-importer canonical YAML emit"
```

---

### Task 7: Unified diff helper

**Files:**
- Create: `packages/state-importer/src/diff.ts`
- Create: `packages/state-importer/test/diff.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "bun:test";
import { unifiedDiff } from "../src/diff.ts";

describe("unifiedDiff", () => {
  it("returns empty string when inputs are identical", () => {
    expect(unifiedDiff("foo\nbar\n", "foo\nbar\n", "file.yaml")).toBe("");
  });

  it("emits a diff header and per-line markers when content differs", () => {
    const before = "foo\nbar\nbaz\n";
    const after = "foo\nBAR\nbaz\n";
    const out = unifiedDiff(before, after, "x.yaml");
    expect(out).toContain("--- x.yaml (on disk)");
    expect(out).toContain("+++ x.yaml (proposed)");
    expect(out).toContain("-bar");
    expect(out).toContain("+BAR");
  });

  it("handles added lines", () => {
    const out = unifiedDiff("a\n", "a\nb\n", "f.yaml");
    expect(out).toContain("+b");
  });

  it("handles removed lines", () => {
    const out = unifiedDiff("a\nb\n", "a\n", "f.yaml");
    expect(out).toContain("-b");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
bun test packages/state-importer/test/diff.test.ts
```
Expected: fails — module not found.

- [ ] **Step 3: Implement `src/diff.ts`**

```ts
/**
 * Tiny unified diff for human display. NOT a real patch generator.
 * Output is line-oriented; matches `diff -u` shape for the simple case.
 */
export function unifiedDiff(before: string, after: string, label: string): string {
  if (before === after) return "";

  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const hunks = computeHunks(beforeLines, afterLines);

  const out: string[] = [
    `--- ${label} (on disk)`,
    `+++ ${label} (proposed)`,
  ];
  for (const h of hunks) {
    out.push(`@@ -${h.beforeStart},${h.beforeLen} +${h.afterStart},${h.afterLen} @@`);
    for (const line of h.lines) out.push(line);
  }
  return out.join("\n") + "\n";
}

interface Hunk {
  beforeStart: number;
  beforeLen: number;
  afterStart: number;
  afterLen: number;
  lines: string[];
}

/** Naive single-hunk diff: scan from each end to find changed range. Good enough for canonical-emit comparisons. */
function computeHunks(before: string[], after: string[]): Hunk[] {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;

  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) tail++;

  const beforeMid = before.slice(head, before.length - tail);
  const afterMid = after.slice(head, after.length - tail);

  const lines: string[] = [];
  // include a few context lines if available
  const ctxBefore = before.slice(Math.max(0, head - 2), head);
  const ctxAfter = before.slice(before.length - tail, Math.min(before.length, before.length - tail + 2));
  for (const c of ctxBefore) lines.push(` ${c}`);
  for (const l of beforeMid) lines.push(`-${l}`);
  for (const l of afterMid) lines.push(`+${l}`);
  for (const c of ctxAfter) lines.push(` ${c}`);

  return [{
    beforeStart: Math.max(1, head - ctxBefore.length + 1),
    beforeLen: ctxBefore.length + beforeMid.length + ctxAfter.length,
    afterStart: Math.max(1, head - ctxBefore.length + 1),
    afterLen: ctxBefore.length + afterMid.length + ctxAfter.length,
    lines,
  }];
}
```

- [ ] **Step 4: Run the test and verify pass**

```bash
bun test packages/state-importer/test/diff.test.ts
```
Expected: all 4 tests pass.

- [ ] **Step 5: Typecheck + commit**

```bash
bun run --filter @synccenter/state-importer typecheck
git add packages/state-importer/
git commit -m "phase-2: state-importer unified diff helper"
```

---

### Task 8: Ruleset matcher

**Files:**
- Create: `packages/state-importer/src/ruleset-match.ts`
- Create: `packages/state-importer/test/ruleset-match.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "bun:test";
import { matchRuleset } from "../src/ruleset-match.ts";

describe("matchRuleset", () => {
  const known = {
    "base-binaries": [".DS_Store", "Thumbs.db", "*.tmp"],
    "dev-monorepo": [".DS_Store", "Thumbs.db", "*.tmp", "**/node_modules/", "**/.env", "!.env.example"],
  };

  it("returns the ruleset name when live ignores match exactly (any order)", () => {
    const live = ["Thumbs.db", "*.tmp", ".DS_Store"];
    expect(matchRuleset(live, known)).toBe("base-binaries");
  });

  it("returns the ruleset whose pattern set is a perfect match (ignoring comments and blanks)", () => {
    const live = [
      "# GENERATED BY synccenter — do not edit",
      "",
      ".DS_Store",
      "Thumbs.db",
      "*.tmp",
      "**/node_modules/",
      "**/.env",
      "!.env.example",
    ];
    expect(matchRuleset(live, known)).toBe("dev-monorepo");
  });

  it("returns null when no known ruleset matches", () => {
    const live = ["just-this.txt"];
    expect(matchRuleset(live, known)).toBeNull();
  });

  it("throws RULESET_AMBIGUOUS when live exactly matches two distinct rulesets (degenerate)", () => {
    const k = { a: ["x"], b: ["x"] };
    expect(() => matchRuleset(["x"], k)).toThrow(/RULESET_AMBIGUOUS/);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
bun test packages/state-importer/test/ruleset-match.test.ts
```
Expected: fails — module not found.

- [ ] **Step 3: Implement `src/ruleset-match.ts`**

```ts
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
      `live ignores match multiple known rulesets: ${matches.join(", ")}`,
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
```

- [ ] **Step 4: Verify tests pass**

```bash
bun test packages/state-importer/test/ruleset-match.test.ts
```
Expected: all 4 tests pass.

- [ ] **Step 5: Typecheck + commit**

```bash
bun run --filter @synccenter/state-importer typecheck
git add packages/state-importer/
git commit -m "phase-2: state-importer ruleset matcher"
```

---

### Task 9: importFolder

**Files:**
- Create: `packages/state-importer/src/import-folder.ts`
- Create: `packages/state-importer/test/import-folder.test.ts`
- Create: `packages/state-importer/test/fixtures/compiled/base-binaries/.stignore` (small fixture copy)
- Modify: `packages/state-importer/src/index.ts`

- [ ] **Step 1: Set up the fixtures**

Copy the compiled rulesets from `synccenter-config/compiled/*` into `packages/state-importer/test/fixtures/compiled/` so tests don't depend on the external repo. Run:

```bash
mkdir -p packages/state-importer/test/fixtures/compiled/base-binaries
mkdir -p packages/state-importer/test/fixtures/compiled/dev-monorepo
cp /Users/ericbaruch/Arik/dev/synccenter-config/compiled/base-binaries/.stignore   packages/state-importer/test/fixtures/compiled/base-binaries/.stignore
cp /Users/ericbaruch/Arik/dev/synccenter-config/compiled/dev-monorepo/.stignore   packages/state-importer/test/fixtures/compiled/dev-monorepo/.stignore
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { importFolder } from "../src/import-folder.ts";
import type { HostInfo } from "../src/types.ts";

function fakeFetch(responses: Map<string, unknown>): typeof fetch {
  return (async (input: Request | string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [pattern, body] of responses) {
      if (url.includes(pattern)) {
        return new Response(typeof body === "string" ? body : JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": typeof body === "string" ? "text/plain" : "application/json" },
        });
      }
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("importFolder", () => {
  let dir: string;
  const hosts: HostInfo[] = [
    { name: "mac-studio", apiUrl: "http://mac:8384", apiKey: "k1" },
    { name: "qnap-ts453d", apiUrl: "http://qnap:8384", apiKey: "k2" },
  ];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "si-folder-"));
    mkdirSync(join(dir, "folders"), { recursive: true });
    mkdirSync(join(dir, "compiled/base-binaries"), { recursive: true });
    writeFileSync(
      join(dir, "compiled/base-binaries/.stignore"),
      "# header\n.DS_Store\nThumbs.db\n*.tmp\n",
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("emits canonical folder YAML and reports 'written' on first run", async () => {
    const fetchImpl = fakeFetch(new Map<string, unknown>([
      ["mac:8384/rest/config/folders/test", { id: "test", label: "test", path: "/Users/eric/Sync/test", type: "sendreceive" }],
      ["qnap:8384/rest/config/folders/test", { id: "test", label: "test", path: "/share/Sync/test", type: "sendreceive" }],
      ["rest/db/ignores", ".DS_Store\nThumbs.db\n*.tmp\n"],
    ]));

    const res = await importFolder("test", { configDir: dir, hosts, write: true, fetch: fetchImpl });
    expect(res.status).toBe("written");
    expect(existsSync(join(dir, "folders/test.yaml"))).toBe(true);

    const written = readFileSync(join(dir, "folders/test.yaml"), "utf8");
    expect(written).toContain("name: test");
    expect(written).toContain("ruleset: base-binaries");
    expect(written).toContain("type: send-receive");
    expect(written).toContain("mac-studio: /Users/eric/Sync/test");
    expect(written).toContain("qnap-ts453d: /share/Sync/test");
  });

  it("reports 'identical' on second run", async () => {
    const fetchImpl = fakeFetch(new Map<string, unknown>([
      ["mac:8384/rest/config/folders/test", { id: "test", label: "test", path: "/Users/eric/Sync/test", type: "sendreceive" }],
      ["qnap:8384/rest/config/folders/test", { id: "test", label: "test", path: "/share/Sync/test", type: "sendreceive" }],
      ["rest/db/ignores", ".DS_Store\nThumbs.db\n*.tmp\n"],
    ]));
    await importFolder("test", { configDir: dir, hosts, write: true, fetch: fetchImpl });
    const second = await importFolder("test", { configDir: dir, hosts, write: false, fetch: fetchImpl });
    expect(second.status).toBe("identical");
  });

  it("reports 'would-change' with a diff when content differs and write is false", async () => {
    writeFileSync(
      join(dir, "folders/test.yaml"),
      "name: test\nruleset: base-binaries\ntype: send-receive\npaths:\n  mac-studio: /WRONG\n",
    );
    const fetchImpl = fakeFetch(new Map<string, unknown>([
      ["mac:8384/rest/config/folders/test", { id: "test", label: "test", path: "/Users/eric/Sync/test", type: "sendreceive" }],
      ["qnap:8384/rest/config/folders/test", { id: "test", label: "test", path: "/share/Sync/test", type: "sendreceive" }],
      ["rest/db/ignores", ".DS_Store\nThumbs.db\n*.tmp\n"],
    ]));
    const res = await importFolder("test", { configDir: dir, hosts, write: false, fetch: fetchImpl });
    expect(res.status).toBe("would-change");
    expect(res.diff).toContain("/WRONG");
    expect(res.diff).toContain("/Users/eric/Sync/test");
  });

  it("throws FOLDER_NOT_PRESENT_ANYWHERE when no host has the folder", async () => {
    const fetchImpl = fakeFetch(new Map());
    await expect(
      importFolder("ghost", { configDir: dir, hosts, fetch: fetchImpl }),
    ).rejects.toMatchObject({ code: "FOLDER_NOT_PRESENT_ANYWHERE" });
  });
});
```

- [ ] **Step 3: Confirm it fails**

```bash
bun test packages/state-importer/test/import-folder.test.ts
```
Expected: fails — module not found.

- [ ] **Step 4: Implement `src/import-folder.ts`**

```ts
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
        throw new ImportError(`failed to read ignores from ${host.name}: ${(err as Error).message}`, "HOST_UNREACHABLE", err);
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

function pickFolderType(types: Set<string>): "send-receive" | "send-only" | "receive-only" | "receive-encrypted" {
  // Syncthing's wire format uses "sendreceive" / "sendonly" / "receiveonly" / "receiveencrypted".
  // The manifest enum uses hyphenated forms. Translate, and prefer the most permissive when hosts differ.
  const norm = [...types].map((t) =>
    t === "sendreceive" ? "send-receive" :
    t === "sendonly" ? "send-only" :
    t === "receiveonly" ? "receive-only" :
    t === "receiveencrypted" ? "receive-encrypted" :
    "send-receive",
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

function writeOrDiff(target: string, proposed: string, resource: ImportResult["resource"], write: boolean | undefined): ImportResult {
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
```

- [ ] **Step 5: Run the test and verify pass**

```bash
bun test packages/state-importer/test/import-folder.test.ts
```
Expected: all 4 tests pass.

- [ ] **Step 6: Update `src/index.ts`**

```ts
export { canonicalEmit, FOLDER_KEY_ORDER, HOST_KEY_ORDER } from "./canonical.ts";
export { unifiedDiff } from "./diff.ts";
export { matchRuleset } from "./ruleset-match.ts";
export { importFolder } from "./import-folder.ts";
export type { ImportResult, ImportResource, ImportStatus, HostInfo, ImportOpts } from "./types.ts";
export { ImportError } from "./errors.ts";
```

- [ ] **Step 7: Typecheck + commit**

```bash
bun run --filter @synccenter/state-importer typecheck
git add packages/state-importer/
git commit -m "phase-2: state-importer importFolder"
```

---

### Task 10: importHost

**Files:**
- Create: `packages/state-importer/src/import-host.ts`
- Create: `packages/state-importer/test/import-host.test.ts`
- Modify: `packages/state-importer/src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { importHost } from "../src/import-host.ts";

function fakeFetch(map: Record<string, unknown>): typeof fetch {
  return (async (input: Request | string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const k of Object.keys(map)) {
      if (url.includes(k)) {
        return new Response(JSON.stringify(map[k]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("importHost", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "si-host-"));
    mkdirSync(join(dir, "hosts"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads /rest/system/status and emits canonical YAML on first run", async () => {
    const fetchImpl = fakeFetch({
      "/rest/system/status": { myID: "AAAA-BBBB-CCCC", platform: "darwin" },
      "/rest/system/version": { version: "v2.1.0" },
    });
    const onDiskHost = {
      name: "mac-studio",
      hostname: "mac.local",
      os: "macos" as const,
      apiUrl: "http://mac:8384",
      apiKey: "key",
    };
    const res = await importHost(onDiskHost, { configDir: dir, hosts: [], write: true, fetch: fetchImpl });
    expect(res.status).toBe("written");
    const written = readFileSync(join(dir, "hosts/mac-studio.yaml"), "utf8");
    expect(written).toContain("name: mac-studio");
    expect(written).toContain("os: macos");
    expect(written).toContain("api_url: http://mac:8384");
  });

  it("reports 'identical' on second run with same live state", async () => {
    const fetchImpl = fakeFetch({
      "/rest/system/status": { myID: "AAAA-BBBB-CCCC", platform: "darwin" },
      "/rest/system/version": { version: "v2.1.0" },
    });
    const onDiskHost = {
      name: "mac-studio", hostname: "mac.local", os: "macos" as const, apiUrl: "http://mac:8384", apiKey: "key",
    };
    await importHost(onDiskHost, { configDir: dir, hosts: [], write: true, fetch: fetchImpl });
    const second = await importHost(onDiskHost, { configDir: dir, hosts: [], write: false, fetch: fetchImpl });
    expect(second.status).toBe("identical");
  });
});
```

- [ ] **Step 2: Confirm it fails**

```bash
bun test packages/state-importer/test/import-host.test.ts
```
Expected: fails — module not found.

- [ ] **Step 3: Implement `src/import-host.ts`**

```ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { SyncthingClient } from "@synccenter/adapters/syncthing";
import { canonicalEmit, HOST_KEY_ORDER } from "./canonical.ts";
import { unifiedDiff } from "./diff.ts";
import { ImportError } from "./errors.ts";
import type { ImportOpts, ImportResult } from "./types.ts";

export interface HostShell {
  name: string;
  hostname: string;
  os: "macos" | "linux" | "windows" | "qnap";
  apiUrl: string;
  apiKey: string;
  /** Existing manifest values we preserve (the importer cannot infer install_method, ssh, etc). */
  preserve?: Record<string, unknown>;
}

export async function importHost(host: HostShell, opts: ImportOpts): Promise<ImportResult> {
  const client = new SyncthingClient({ baseUrl: host.apiUrl, apiKey: host.apiKey, fetch: opts.fetch });

  let status: { myID: string };
  try {
    status = await client.getStatus();
  } catch (err) {
    throw new ImportError(`failed to query ${host.name}: ${(err as Error).message}`, "HOST_UNREACHABLE", err);
  }

  const target = join(opts.configDir, "hosts", `${host.name}.yaml`);
  const existing = existsSync(target)
    ? readFileSync(target, "utf8")
    : "";

  // Preserve any operator-set fields not derivable from /rest/system/status.
  // The shape below is the minimum the importer can know on its own;
  // the secrets refs and install_method survive untouched if present on disk.
  const proposed: Record<string, unknown> = {
    name: host.name,
    hostname: host.hostname,
    os: host.os,
    ...host.preserve,
    syncthing: {
      ...((host.preserve?.syncthing as Record<string, unknown>) ?? {}),
      api_url: host.apiUrl,
      api_key_ref: ((host.preserve?.syncthing as { api_key_ref?: string })?.api_key_ref) ?? `secrets/syncthing-api-keys.enc.yaml#${host.name}`,
      device_id_ref: ((host.preserve?.syncthing as { device_id_ref?: string })?.device_id_ref) ?? `secrets/syncthing-device-ids.enc.yaml#${host.name}`,
      // Recorded but not committed if the operator's YAML omits it.
      _live_device_id: status.myID,
    },
  };
  // The _live_device_id is only included to help the operator see drift in the diff;
  // strip before emit if the operator wants pure manifest format.
  if (!proposed.syncthing || typeof proposed.syncthing !== "object") {
    throw new ImportError("internal: bad syncthing block", "WRITE_BLOCKED");
  }
  delete (proposed.syncthing as Record<string, unknown>)._live_device_id;

  const yaml = canonicalEmit(proposed, HOST_KEY_ORDER);
  if (existing === yaml) {
    return { resource: { kind: "host", name: host.name }, path: target, status: "identical" };
  }
  const diff = unifiedDiff(existing, yaml, target);
  if (!opts.write) {
    return { resource: { kind: "host", name: host.name }, path: target, status: "would-change", diff };
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, yaml, "utf8");
  return { resource: { kind: "host", name: host.name }, path: target, status: "written", diff };
}
```

- [ ] **Step 4: Verify tests pass**

```bash
bun test packages/state-importer/test/import-host.test.ts
```
Expected: both tests pass.

- [ ] **Step 5: Update `src/index.ts`**

```ts
export { importHost } from "./import-host.ts";
// (keep existing exports)
```

- [ ] **Step 6: Typecheck + commit**

```bash
bun run --filter @synccenter/state-importer typecheck
git add packages/state-importer/
git commit -m "phase-2: state-importer importHost"
```

---

### Task 11: importAll

**Files:**
- Create: `packages/state-importer/src/import-all.ts`
- Create: `packages/state-importer/test/import-all.test.ts`
- Modify: `packages/state-importer/src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { importAll } from "../src/import-all.ts";
import type { HostInfo } from "../src/types.ts";

function fakeFetch(map: Record<string, unknown>): typeof fetch {
  return (async (input: Request | string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const k of Object.keys(map)) {
      if (url.includes(k)) {
        const body = map[k];
        return new Response(typeof body === "string" ? body : JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": typeof body === "string" ? "text/plain" : "application/json" },
        });
      }
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("importAll", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "si-all-"));
    mkdirSync(join(dir, "folders"), { recursive: true });
    mkdirSync(join(dir, "hosts"), { recursive: true });
    mkdirSync(join(dir, "compiled/base-binaries"), { recursive: true });
    writeFileSync(join(dir, "compiled/base-binaries/.stignore"), ".DS_Store\nThumbs.db\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("imports every folder that's present on any host plus every declared host", async () => {
    const hosts: HostInfo[] = [
      { name: "mac-studio", apiUrl: "http://mac:8384", apiKey: "k1" },
      { name: "qnap-ts453d", apiUrl: "http://qnap:8384", apiKey: "k2" },
    ];
    // Pre-existing host YAML so importHost has shell data.
    writeFileSync(join(dir, "hosts/mac-studio.yaml"), "name: mac-studio\nhostname: mac.local\nos: macos\nsyncthing:\n  install_method: brew\n  api_url: http://mac:8384\n  api_key_ref: secrets/syncthing-api-keys.enc.yaml#mac-studio\n  device_id_ref: secrets/syncthing-device-ids.enc.yaml#mac-studio\n");
    writeFileSync(join(dir, "hosts/qnap-ts453d.yaml"), "name: qnap-ts453d\nhostname: qnap.local\nos: qnap\nsyncthing:\n  install_method: docker\n  api_url: http://qnap:8384\n  api_key_ref: secrets/syncthing-api-keys.enc.yaml#qnap-ts453d\n  device_id_ref: secrets/syncthing-device-ids.enc.yaml#qnap-ts453d\n");

    const fetchImpl = fakeFetch({
      "mac:8384/rest/config/folders": [{ id: "test", label: "test", path: "/Users/eric/Sync/test", type: "sendreceive" }],
      "qnap:8384/rest/config/folders": [{ id: "test", label: "test", path: "/share/Sync/test", type: "sendreceive" }],
      "/rest/config/folders/test": { id: "test", label: "test", path: "/p", type: "sendreceive" },
      "/rest/db/ignores": ".DS_Store\nThumbs.db\n",
      "mac:8384/rest/system/status": { myID: "AAA" },
      "qnap:8384/rest/system/status": { myID: "BBB" },
    });

    const results = await importAll({ configDir: dir, hosts, write: true, fetch: fetchImpl });
    const folderResults = results.filter((r) => r.resource.kind === "folder");
    const hostResults = results.filter((r) => r.resource.kind === "host");
    expect(folderResults.map((r) => r.resource.name)).toContain("test");
    expect(hostResults.map((r) => r.resource.name).sort()).toEqual(["mac-studio", "qnap-ts453d"]);
  });
});
```

- [ ] **Step 2: Confirm it fails**

```bash
bun test packages/state-importer/test/import-all.test.ts
```
Expected: fails — module not found.

- [ ] **Step 3: Implement `src/import-all.ts`**

```ts
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { parse } from "yaml";
import { SyncthingClient } from "@synccenter/adapters/syncthing";
import { importFolder } from "./import-folder.ts";
import { importHost, type HostShell } from "./import-host.ts";
import { ImportError } from "./errors.ts";
import type { ImportOpts, ImportResult } from "./types.ts";

export async function importAll(opts: ImportOpts): Promise<ImportResult[]> {
  const results: ImportResult[] = [];

  // 1. Discover every folder ID present on any host.
  const folderIds = new Set<string>();
  for (const host of opts.hosts) {
    const client = new SyncthingClient({ baseUrl: host.apiUrl, apiKey: host.apiKey, fetch: opts.fetch });
    try {
      const folders = await client.getFolders();
      for (const f of folders) folderIds.add(f.id);
    } catch (err) {
      throw new ImportError(`failed to list folders on ${host.name}`, "HOST_UNREACHABLE", err);
    }
  }

  // 2. Import each folder.
  for (const id of [...folderIds].sort()) {
    results.push(await importFolder(id, opts));
  }

  // 3. Import every declared host.
  for (const host of opts.hosts) {
    const onDisk = readHostShell(opts.configDir, host);
    results.push(await importHost(onDisk, opts));
  }

  return results;
}

function readHostShell(configDir: string, host: { name: string; apiUrl: string; apiKey: string }): HostShell {
  const target = join(configDir, "hosts", `${host.name}.yaml`);
  if (!existsSync(target)) {
    return {
      name: host.name,
      hostname: host.name,
      os: "linux",
      apiUrl: host.apiUrl,
      apiKey: host.apiKey,
    };
  }
  const doc = parse(readFileSync(target, "utf8")) as Record<string, unknown>;
  const { name, hostname, os, ...rest } = doc;
  return {
    name: (name as string) ?? host.name,
    hostname: (hostname as string) ?? host.name,
    os: (os as HostShell["os"]) ?? "linux",
    apiUrl: host.apiUrl,
    apiKey: host.apiKey,
    preserve: rest,
  };
}
```

- [ ] **Step 4: Verify tests pass**

```bash
bun test packages/state-importer/test/import-all.test.ts
```
Expected: passes.

- [ ] **Step 5: Update `src/index.ts`**

```ts
export { importAll } from "./import-all.ts";
// (keep existing exports)
```

- [ ] **Step 6: Run the full state-importer test suite**

```bash
bun test --cwd packages/state-importer
```
Expected: every test passes.

- [ ] **Step 7: Typecheck + commit**

```bash
bun run --filter @synccenter/state-importer typecheck
git add packages/state-importer/
git commit -m "phase-2: state-importer importAll"
```

---

### Task 12: Create apply-planner package skeleton

**Files:**
- Create: `packages/apply-planner/package.json`
- Create: `packages/apply-planner/tsconfig.json`
- Create: `packages/apply-planner/README.md`
- Create: `packages/apply-planner/src/index.ts`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "@synccenter/apply-planner",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "build": "echo 'apply-planner: bundle in phase 3'"
  },
  "dependencies": {
    "@synccenter/adapters": "workspace:*",
    "@synccenter/rule-compiler": "workspace:*",
    "@synccenter/schema": "workspace:*",
    "ajv": "^8.12.0",
    "yaml": "^2.5.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "." },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Write `README.md`**

```markdown
# packages/apply-planner

Manifest compiler: folder + host manifests + compiled rulesets → typed ApplyPlan
(Syncthing REST operations + rclone bisync SchedulePlan), and the execute/verify layer.

Pure `plan()` is golden-tested. Side-effecting `apply()`/`verify()` use the existing
`@synccenter/adapters` clients.

## Surfaces

- `plan(folder, hosts, ruleset, compiledRules, secretsResolver) → ApplyPlan` — pure
- `computeDelta(plan, liveState) → DriftReport` — pure
- `apply(plan, adapters, opts) → ApplyResult` — side-effecting
- `verify(plan, adapters) → VerifyResult` — side-effecting (read-only)
- `renderCrontab(SchedulePlan[]) → string` — pure

## Conventions

- `plan()` never decrypts secrets — it records refs. Decryption happens in `apply()`.
- Apply ops are ordered per host: `addDevice* → addFolder → setIgnores → patchFolder`.
- Per-host failures do not abort other hosts; results are returned per-host.
```

- [ ] **Step 4: Write empty `src/index.ts`**

```ts
export {};
```

- [ ] **Step 5: Install + typecheck**

```bash
cd /Users/ericbaruch/Arik/dev/synccenter && bun install
bun run --filter @synccenter/apply-planner typecheck
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/apply-planner/
git commit -m "phase-2: apply-planner package skeleton"
```

---

### Task 13: apply-planner types + errors

**Files:**
- Create: `packages/apply-planner/src/types.ts`
- Create: `packages/apply-planner/src/errors.ts`
- Modify: `packages/apply-planner/src/index.ts`

- [ ] **Step 1: Write `src/types.ts`**

```ts
import type { SyncthingClient } from "@synccenter/adapters/syncthing";
import type { RcloneClient } from "@synccenter/adapters/rclone";

export type HostName = string;

export type FolderType = "send-receive" | "send-only" | "receive-only" | "receive-encrypted";

export interface SyncthingFolderDevice {
  deviceID: string;
}

export interface SyncthingFolderConfig {
  id: string;
  label: string;
  path: string;
  type: "sendreceive" | "sendonly" | "receiveonly" | "receiveencrypted";
  devices: SyncthingFolderDevice[];
  ignorePerms?: boolean;
  fsWatcherEnabled?: boolean;
  fsWatcherDelayS?: number;
  paused?: boolean;
}

export type SyncthingOp =
  | { kind: "addDevice"; host: HostName; deviceID: string; name: string; addresses?: string[] }
  | { kind: "addFolder"; host: HostName; folder: SyncthingFolderConfig }
  | { kind: "patchFolder"; host: HostName; folderId: string; patch: Partial<SyncthingFolderConfig> }
  | { kind: "setIgnores"; host: HostName; folderId: string; lines: string[] }
  | { kind: "removeFolder"; host: HostName; folderId: string };

export interface SchedulePlan {
  anchor: HostName;
  folder: string;
  cron: string;
  command: string;
  filtersFile: string;
}

export interface ApplyPlan {
  folder: string;
  perHost: Record<HostName, SyncthingOp[]>;
  schedule: SchedulePlan[];
  warnings: string[];
}

export interface DriftReport {
  manifestOnly: SyncthingOp[];
  liveOnly: { host: HostName; folderId: string }[];
  divergent: { host: HostName; path: string; expected: unknown; actual: unknown }[];
}

export interface PlanContext {
  rulesetsDir: string;
  importsDir: string;
  compiledRulesDir: string;
  commitSha?: string;
  now?: Date;
}

export interface SecretsResolver {
  resolve(ref: string): string;
}

export interface ApplyOpts {
  dryRun?: boolean;
  prune?: boolean;
  force?: boolean;
  hostTimeoutMs?: number;
}

export interface HostApplyResult {
  host: HostName;
  status: "applied" | "skipped" | "failed";
  ops: SyncthingOp[];
  error?: { code: string; message: string };
}

export interface ApplyResult {
  folder: string;
  hosts: HostApplyResult[];
  schedule: SchedulePlan[];
  verified: boolean;
}

export interface AdapterPool {
  syncthing(host: HostName): SyncthingClient;
  rclone(host: HostName): RcloneClient;
}
```

- [ ] **Step 2: Write `src/errors.ts`**

```ts
import type { DriftReport, ApplyResult } from "./types.ts";

export type PlanErrorCode =
  | "MANIFEST_NOT_FOUND"
  | "SCHEMA_INVALID"
  | "UNKNOWN_HOST"
  | "MISSING_RULESET"
  | "MULTIPLE_CLOUD_EDGE"
  | "NO_CLOUD_EDGE_FOR_BISYNC"
  | "SECRET_REF_INVALID"
  | "SOPS_DECRYPT_FAILED";

export type DriftErrorCode =
  | "LIVE_ONLY_FOLDER"
  | "LIVE_ONLY_DEVICE"
  | "DIVERGENT_FIELD"
  | "DIVERGENT_IGNORES";

export type ApplyErrorCode =
  | "HOST_UNREACHABLE"
  | "ADAPTER_TIMEOUT"
  | "ADAPTER_4XX"
  | "ADAPTER_5XX"
  | "VERIFY_FAILED"
  | "BISYNC_NEEDS_RESYNC";

export class PlanError extends Error {
  override readonly cause: unknown;
  constructor(message: string, public readonly code: PlanErrorCode, cause?: unknown) {
    super(message);
    this.name = "PlanError";
    this.cause = cause;
  }
}

export class DriftError extends Error {
  constructor(
    message: string,
    public readonly code: DriftErrorCode,
    public readonly report: DriftReport,
  ) {
    super(message);
    this.name = "DriftError";
  }
}

export class ApplyError extends Error {
  override readonly cause: unknown;
  constructor(
    message: string,
    public readonly code: ApplyErrorCode,
    public readonly partial?: ApplyResult,
    cause?: unknown,
  ) {
    super(message);
    this.name = "ApplyError";
    this.cause = cause;
  }
}
```

- [ ] **Step 3: Update `src/index.ts`**

```ts
export type {
  ApplyPlan,
  ApplyOpts,
  ApplyResult,
  AdapterPool,
  DriftReport,
  HostApplyResult,
  HostName,
  FolderType,
  PlanContext,
  SchedulePlan,
  SecretsResolver,
  SyncthingFolderConfig,
  SyncthingFolderDevice,
  SyncthingOp,
} from "./types.ts";
export { PlanError, DriftError, ApplyError } from "./errors.ts";
```

- [ ] **Step 4: Typecheck**

```bash
bun run --filter @synccenter/apply-planner typecheck
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/apply-planner/src/
git commit -m "phase-2: apply-planner types + errors"
```

---

### Task 14: Manifest loader + ajv validation

**Files:**
- Create: `packages/apply-planner/src/load.ts`
- Create: `packages/apply-planner/test/load.test.ts`
- Create: `packages/apply-planner/test/fixtures/folders/test.yaml`
- Create: `packages/apply-planner/test/fixtures/hosts/{mac-studio,qnap-ts453d,win-desktop}.yaml`

- [ ] **Step 1: Copy fixtures from `synccenter-config/`**

```bash
mkdir -p packages/apply-planner/test/fixtures/folders packages/apply-planner/test/fixtures/hosts
cp /Users/ericbaruch/Arik/dev/synccenter-config/folders/test.yaml                packages/apply-planner/test/fixtures/folders/
cp /Users/ericbaruch/Arik/dev/synccenter-config/folders/example-code-projects.yaml packages/apply-planner/test/fixtures/folders/
cp /Users/ericbaruch/Arik/dev/synccenter-config/hosts/mac-studio.yaml             packages/apply-planner/test/fixtures/hosts/
cp /Users/ericbaruch/Arik/dev/synccenter-config/hosts/qnap-ts453d.yaml            packages/apply-planner/test/fixtures/hosts/
cp /Users/ericbaruch/Arik/dev/synccenter-config/hosts/win-desktop.yaml            packages/apply-planner/test/fixtures/hosts/
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect } from "bun:test";
import { join } from "path";
import { loadFolderManifest, loadAllHosts } from "../src/load.ts";

const FIX = join(import.meta.dir, "fixtures");

describe("loadFolderManifest", () => {
  it("loads test.yaml and validates against the folder schema", () => {
    const f = loadFolderManifest(join(FIX, "folders/test.yaml"));
    expect(f.name).toBe("test");
    expect(f.type).toBeDefined();
    expect(f.paths).toBeDefined();
  });

  it("loads example-code-projects.yaml with cloud + bisync", () => {
    const f = loadFolderManifest(join(FIX, "folders/example-code-projects.yaml"));
    expect(f.name).toBe("example-code-projects");
    expect(f.cloud?.rclone_remote).toBe("gdrive");
    expect(f.cloud?.bisync?.schedule).toBe("*/15 * * * *");
  });

  it("throws PlanError(MANIFEST_NOT_FOUND) when the file doesn't exist", () => {
    expect(() => loadFolderManifest(join(FIX, "folders/nope.yaml"))).toThrow(/MANIFEST_NOT_FOUND/);
  });

  it("throws PlanError(SCHEMA_INVALID) when a required field is missing", () => {
    // Create a temp bad file.
    const { writeFileSync, mkdtempSync, rmSync } = require("fs");
    const { tmpdir } = require("os");
    const tmp = mkdtempSync(join(tmpdir(), "ap-"));
    const p = join(tmp, "bad.yaml");
    writeFileSync(p, "name: bad\n"); // missing required fields
    try {
      expect(() => loadFolderManifest(p)).toThrow(/SCHEMA_INVALID/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("loadAllHosts", () => {
  it("returns every host in hosts/ keyed by name", () => {
    const hosts = loadAllHosts(join(FIX, "hosts"));
    expect(Object.keys(hosts).sort()).toEqual(["mac-studio", "qnap-ts453d", "win-desktop"]);
  });

  it("throws PlanError(SCHEMA_INVALID) when a host file is malformed", () => {
    expect(() => loadAllHosts(join(FIX, "no-such-dir"))).toThrow();
  });
});
```

- [ ] **Step 3: Confirm it fails**

```bash
bun test packages/apply-planner/test/load.test.ts
```
Expected: fails — module not found.

- [ ] **Step 4: Implement `src/load.ts`**

```ts
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { parse } from "yaml";
import Ajv, { type ValidateFunction } from "ajv";
import { PlanError } from "./errors.ts";

const schemaDir = join(import.meta.dir, "..", "..", "schema");
const ajv = new Ajv({ strict: false, allErrors: true });

let folderValidator: ValidateFunction | null = null;
let hostValidator: ValidateFunction | null = null;

function folderSchema(): ValidateFunction {
  if (folderValidator) return folderValidator;
  const schema = JSON.parse(readFileSync(join(schemaDir, "folder.schema.json"), "utf8"));
  folderValidator = ajv.compile(schema);
  return folderValidator;
}

function hostSchema(): ValidateFunction {
  if (hostValidator) return hostValidator;
  const schema = JSON.parse(readFileSync(join(schemaDir, "host.schema.json"), "utf8"));
  hostValidator = ajv.compile(schema);
  return hostValidator;
}

export interface FolderManifest {
  name: string;
  ruleset: string;
  type: "send-receive" | "send-only" | "receive-only" | "receive-encrypted";
  paths: Record<string, string>;
  cloud?: {
    rclone_remote: string;
    remote_path: string;
    anchor?: string;
    bisync?: { schedule?: string; flags?: string[] };
  };
  conflict?: { policy: "newer" | "older" | "keep-both" | "require-resolve"; surface_to_ui?: boolean };
  versioning?: { type?: "off" | "trash" | "simple" | "staggered"; params?: Record<string, unknown> };
  overrides?: Record<string, Partial<Omit<FolderManifest, "name" | "ruleset" | "paths" | "cloud" | "conflict" | "overrides">>>;
  ignore_perms?: boolean;
  fs_watcher_enabled?: boolean;
  fs_watcher_delay_s?: number;
}

export interface HostManifest {
  name: string;
  hostname: string;
  ip?: string;
  os: "macos" | "linux" | "windows" | "qnap";
  role: "mesh-node" | "hub" | "cloud-edge";
  ssh?: { user: string; port?: number; key_ref?: string };
  syncthing: {
    install_method: "brew" | "docker" | "qpkg" | "synctrayzor" | "winget+nssm";
    api_url: string;
    api_key_ref: string;
    device_id_ref: string;
    binary_path?: string;
    home_dir?: string;
  };
  rclone?: { rcd_url: string; auth_ref: string };
}

export function loadFolderManifest(path: string): FolderManifest {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new PlanError(`folder manifest not found: ${path}`, "MANIFEST_NOT_FOUND", cause);
  }
  const parsed = parse(raw);
  const validate = folderSchema();
  if (!validate(parsed)) {
    throw new PlanError(
      `schema invalid in ${path}: ${ajv.errorsText(validate.errors)}`,
      "SCHEMA_INVALID",
    );
  }
  return parsed as FolderManifest;
}

export function loadHostManifest(path: string): HostManifest {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new PlanError(`host manifest not found: ${path}`, "MANIFEST_NOT_FOUND", cause);
  }
  const parsed = parse(raw);
  const validate = hostSchema();
  if (!validate(parsed)) {
    throw new PlanError(
      `schema invalid in ${path}: ${ajv.errorsText(validate.errors)}`,
      "SCHEMA_INVALID",
    );
  }
  return parsed as HostManifest;
}

export function loadAllHosts(hostsDir: string): Record<string, HostManifest> {
  if (!existsSync(hostsDir)) {
    throw new PlanError(`hosts dir not found: ${hostsDir}`, "MANIFEST_NOT_FOUND");
  }
  const out: Record<string, HostManifest> = {};
  for (const f of readdirSync(hostsDir)) {
    if (!f.endsWith(".yaml") || f === "README.md") continue;
    const host = loadHostManifest(join(hostsDir, f));
    out[host.name] = host;
  }
  return out;
}
```

Note: `schemaDir` above assumes the schema package is at `../../schema` relative to `src/`. Verify the path is correct at build time by checking that `readFileSync(join(import.meta.dir, "..", "..", "schema", "folder.schema.json"))` resolves to `packages/schema/folder.schema.json`. If not, adjust to use `require.resolve("@synccenter/schema/folder.schema.json")` or a workspace import. The first approach (relative path) works for the dev/test workflow.

- [ ] **Step 5: Verify tests pass**

```bash
bun test packages/apply-planner/test/load.test.ts
```
Expected: all 6 tests pass.

- [ ] **Step 6: Typecheck + commit**

```bash
bun run --filter @synccenter/apply-planner typecheck
git add packages/apply-planner/
git commit -m "phase-2: apply-planner manifest loader + ajv validation"
```

---

### Task 15: Secrets resolver via sops

**Files:**
- Create: `packages/apply-planner/src/secrets.ts`
- Create: `packages/apply-planner/test/secrets.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "bun:test";
import { createSecretsResolver } from "../src/secrets.ts";

describe("createSecretsResolver", () => {
  it("invokes sops with --extract and returns the resolved value", () => {
    const calls: { argv: string[] }[] = [];
    const resolver = createSecretsResolver({
      configDir: "/cfg",
      spawn: (argv: string[]) => {
        calls.push({ argv });
        return { stdout: "the-secret", status: 0, stderr: "" };
      },
    });
    const val = resolver.resolve("secrets/syncthing-api-keys.enc.yaml#mac-studio");
    expect(val).toBe("the-secret");
    expect(calls[0]!.argv).toEqual([
      "sops", "-d", "--extract", '["mac-studio"]', "/cfg/secrets/syncthing-api-keys.enc.yaml",
    ]);
  });

  it("caches subsequent resolves of the same ref", () => {
    let count = 0;
    const resolver = createSecretsResolver({
      configDir: "/cfg",
      spawn: () => { count++; return { stdout: "x", status: 0, stderr: "" }; },
    });
    resolver.resolve("secrets/a.enc.yaml#k");
    resolver.resolve("secrets/a.enc.yaml#k");
    expect(count).toBe(1);
  });

  it("throws SECRET_REF_INVALID when the ref has no '#'", () => {
    const resolver = createSecretsResolver({
      configDir: "/cfg",
      spawn: () => { throw new Error("should not be called"); },
    });
    expect(() => resolver.resolve("secrets/a.enc.yaml")).toThrow(/SECRET_REF_INVALID/);
  });

  it("throws SOPS_DECRYPT_FAILED when sops exits non-zero", () => {
    const resolver = createSecretsResolver({
      configDir: "/cfg",
      spawn: () => ({ stdout: "", status: 1, stderr: "no key" }),
    });
    expect(() => resolver.resolve("secrets/a.enc.yaml#k")).toThrow(/SOPS_DECRYPT_FAILED/);
  });
});
```

- [ ] **Step 2: Confirm it fails**

```bash
bun test packages/apply-planner/test/secrets.test.ts
```
Expected: module not found.

- [ ] **Step 3: Implement `src/secrets.ts`**

```ts
import { join } from "path";
import { PlanError } from "./errors.ts";
import type { SecretsResolver } from "./types.ts";

export interface SpawnResult {
  stdout: string;
  stderr: string;
  status: number;
}

export interface SecretsResolverOpts {
  configDir: string;
  /** Injectable for tests; defaults to Bun.spawnSync wrapper. */
  spawn?: (argv: string[]) => SpawnResult;
}

export function createSecretsResolver(opts: SecretsResolverOpts): SecretsResolver {
  const cache = new Map<string, string>();
  const spawn = opts.spawn ?? defaultSpawn;
  return {
    resolve(ref: string): string {
      const cached = cache.get(ref);
      if (cached !== undefined) return cached;
      const sep = ref.indexOf("#");
      if (sep === -1) {
        throw new PlanError(`invalid secret ref (missing '#'): ${ref}`, "SECRET_REF_INVALID");
      }
      const relPath = ref.slice(0, sep);
      const key = ref.slice(sep + 1);
      const absPath = join(opts.configDir, relPath);
      const argv = ["sops", "-d", "--extract", `["${key}"]`, absPath];
      const res = spawn(argv);
      if (res.status !== 0) {
        throw new PlanError(
          `sops failed (exit ${res.status}) for ${ref}: ${res.stderr.trim()}`,
          "SOPS_DECRYPT_FAILED",
        );
      }
      const value = res.stdout.replace(/\n$/, "");
      cache.set(ref, value);
      return value;
    },
  };
}

function defaultSpawn(argv: string[]): SpawnResult {
  // Bun.spawnSync — synchronous wrapper around child_process.
  const proc = Bun.spawnSync({ cmd: argv, stdout: "pipe", stderr: "pipe" });
  return {
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
    status: proc.exitCode ?? 0,
  };
}
```

- [ ] **Step 4: Verify tests pass**

```bash
bun test packages/apply-planner/test/secrets.test.ts
```
Expected: all 4 tests pass.

- [ ] **Step 5: Typecheck + commit**

```bash
bun run --filter @synccenter/apply-planner typecheck
git add packages/apply-planner/
git commit -m "phase-2: apply-planner secrets resolver via sops"
```

---

### Task 16: Conflict policy mapper

**Files:**
- Create: `packages/apply-planner/src/conflict.ts`
- Create: `packages/apply-planner/test/conflict.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "bun:test";
import { mapPolicy } from "../src/conflict.ts";

describe("mapPolicy", () => {
  it("maps 'newer' to rclone --conflict-resolve=newer + Syncthing maxConflicts -1", () => {
    const m = mapPolicy("newer");
    expect(m.rcloneFlags).toContain("--conflict-resolve=newer");
    expect(m.syncthingMaxConflicts).toBe(-1);
  });

  it("maps 'older' symmetrically", () => {
    const m = mapPolicy("older");
    expect(m.rcloneFlags).toContain("--conflict-resolve=older");
    expect(m.syncthingMaxConflicts).toBe(-1);
  });

  it("maps 'keep-both' to rclone --conflict-resolve=none and surfaces all conflicts", () => {
    const m = mapPolicy("keep-both");
    expect(m.rcloneFlags).toContain("--conflict-resolve=none");
    expect(m.syncthingMaxConflicts).toBe(-1);
  });

  it("maps 'require-resolve' to rclone --conflict-resolve=none and Syncthing maxConflicts 0", () => {
    const m = mapPolicy("require-resolve");
    expect(m.rcloneFlags).toContain("--conflict-resolve=none");
    expect(m.syncthingMaxConflicts).toBe(0);
  });

  it("returns the system default when no policy is given", () => {
    const m = mapPolicy(undefined);
    expect(m.rcloneFlags).toContain("--conflict-resolve=newer");
    expect(m.syncthingMaxConflicts).toBe(-1);
  });
});
```

- [ ] **Step 2: Confirm it fails**

```bash
bun test packages/apply-planner/test/conflict.test.ts
```
Expected: module not found.

- [ ] **Step 3: Implement `src/conflict.ts`**

```ts
export type ConflictPolicy = "newer" | "older" | "keep-both" | "require-resolve";

export interface PolicyMapping {
  rcloneFlags: string[];
  syncthingMaxConflicts: number; // -1 = unlimited, 0 = disallow, N = cap
}

const DEFAULT_POLICY: ConflictPolicy = "newer";

export function mapPolicy(policy: ConflictPolicy | undefined): PolicyMapping {
  const p = policy ?? DEFAULT_POLICY;
  switch (p) {
    case "newer":
      return { rcloneFlags: ["--conflict-resolve=newer", "--conflict-loser=pathrename"], syncthingMaxConflicts: -1 };
    case "older":
      return { rcloneFlags: ["--conflict-resolve=older", "--conflict-loser=pathrename"], syncthingMaxConflicts: -1 };
    case "keep-both":
      return { rcloneFlags: ["--conflict-resolve=none", "--conflict-loser=num"], syncthingMaxConflicts: -1 };
    case "require-resolve":
      return { rcloneFlags: ["--conflict-resolve=none", "--conflict-loser=num"], syncthingMaxConflicts: 0 };
  }
}
```

- [ ] **Step 4: Verify tests pass**

```bash
bun test packages/apply-planner/test/conflict.test.ts
```
Expected: all 5 tests pass.

- [ ] **Step 5: Typecheck + commit**

```bash
bun run --filter @synccenter/apply-planner typecheck
git add packages/apply-planner/
git commit -m "phase-2: apply-planner conflict policy mapper"
```

---

### Task 17: Schedule builder + crontab renderer

**Files:**
- Create: `packages/apply-planner/src/schedule.ts`
- Create: `packages/apply-planner/src/render-crontab.ts`
- Create: `packages/apply-planner/test/schedule.test.ts`
- Create: `packages/apply-planner/test/render-crontab.test.ts`
- Create: `packages/apply-planner/test/golden/crontab-example-code-projects.cron`

- [ ] **Step 1: Write `test/schedule.test.ts`**

```ts
import { describe, it, expect } from "bun:test";
import { buildSchedulePlan } from "../src/schedule.ts";
import type { FolderManifest, HostManifest } from "../src/load.ts";

const QNAP: HostManifest = {
  name: "qnap-ts453d", hostname: "qnap.local", os: "qnap", role: "cloud-edge",
  syncthing: { install_method: "docker", api_url: "http://127.0.0.1:8384", api_key_ref: "secrets/x#qnap", device_id_ref: "secrets/y#qnap" },
};

describe("buildSchedulePlan", () => {
  it("returns empty array when folder has no cloud block", () => {
    const folder: FolderManifest = { name: "test", ruleset: "x", type: "send-receive", paths: { "qnap-ts453d": "/p" } };
    expect(buildSchedulePlan(folder, QNAP, "/cfg/compiled/x/filter.rclone")).toEqual([]);
  });

  it("emits a SchedulePlan with command containing path1, path2, filters_file", () => {
    const folder: FolderManifest = {
      name: "code", ruleset: "dev-monorepo", type: "send-receive",
      paths: { "qnap-ts453d": "/share/Sync/code" },
      cloud: {
        rclone_remote: "gdrive", remote_path: "sync/code",
        bisync: { schedule: "*/15 * * * *", flags: ["--resilient"] },
      },
    };
    const plans = buildSchedulePlan(folder, QNAP, "/cfg/compiled/dev-monorepo/filter.rclone");
    expect(plans).toHaveLength(1);
    expect(plans[0]!.anchor).toBe("qnap-ts453d");
    expect(plans[0]!.cron).toBe("*/15 * * * *");
    expect(plans[0]!.command).toContain("/share/Sync/code");
    expect(plans[0]!.command).toContain("gdrive:sync/code");
    expect(plans[0]!.command).toContain("--filters-file=/cfg/compiled/dev-monorepo/filter.rclone");
    expect(plans[0]!.command).toContain("--resilient");
  });
});
```

- [ ] **Step 2: Write `test/render-crontab.test.ts`**

```ts
import { describe, it, expect } from "bun:test";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { renderCrontab } from "../src/render-crontab.ts";
import type { SchedulePlan } from "../src/types.ts";

const GOLDEN = join(import.meta.dir, "golden/crontab-example-code-projects.cron");

describe("renderCrontab", () => {
  it("renders a single bisync schedule into a stable crontab fragment", () => {
    const plans: SchedulePlan[] = [{
      anchor: "qnap-ts453d",
      folder: "example-code-projects",
      cron: "*/15 * * * *",
      filtersFile: "/share/synccenter-config/compiled/dev-monorepo/filter.rclone",
      command: 'docker exec rclone-rcd rclone bisync /share/Sync/code gdrive:sync/code --filters-file=/share/synccenter-config/compiled/dev-monorepo/filter.rclone --resilient --recover --max-lock=2m --conflict-resolve=newer --conflict-loser=pathrename',
    }];
    const out = renderCrontab(plans);
    if (process.env["BUN_UPDATE_GOLDEN"] === "1" || !existsSync(GOLDEN)) {
      writeFileSync(GOLDEN, out, "utf8");
    }
    const expected = readFileSync(GOLDEN, "utf8");
    expect(out).toBe(expected);
  });

  it("emits empty string for an empty schedule list", () => {
    expect(renderCrontab([])).toBe("");
  });
});
```

- [ ] **Step 3: Confirm both tests fail**

```bash
bun test packages/apply-planner/test/schedule.test.ts packages/apply-planner/test/render-crontab.test.ts
```
Expected: modules not found.

- [ ] **Step 4: Implement `src/schedule.ts`**

```ts
import { mapPolicy } from "./conflict.ts";
import type { FolderManifest, HostManifest } from "./load.ts";
import type { SchedulePlan, HostName } from "./types.ts";

export function buildSchedulePlan(
  folder: FolderManifest,
  anchor: HostManifest,
  filtersFile: string,
): SchedulePlan[] {
  if (!folder.cloud) return [];
  const schedule = folder.cloud.bisync?.schedule;
  if (!schedule) return [];

  const localPath = folder.paths[anchor.name];
  if (!localPath) return [];

  const remotePath = `${folder.cloud.rclone_remote}:${folder.cloud.remote_path}`;
  const conflictFlags = mapPolicy(folder.conflict?.policy).rcloneFlags;
  const userFlags = folder.cloud.bisync?.flags ?? [];

  // Strip any user-supplied --conflict-* flags so the unified policy wins,
  // unless the user explicitly opted out via conflict.policy missing AND raw flags present.
  const userConflict = userFlags.some((f) => f.startsWith("--conflict-"));
  const useUnified = folder.conflict?.policy !== undefined || !userConflict;
  const effectiveFlags = useUnified
    ? [...userFlags.filter((f) => !f.startsWith("--conflict-")), ...conflictFlags]
    : userFlags;

  const cmd = [
    "docker", "exec", "rclone-rcd",
    "rclone", "bisync",
    localPath,
    remotePath,
    `--filters-file=${filtersFile}`,
    ...effectiveFlags,
  ].join(" ");

  return [{
    anchor: anchor.name as HostName,
    folder: folder.name,
    cron: schedule,
    command: cmd,
    filtersFile,
  }];
}
```

- [ ] **Step 5: Implement `src/render-crontab.ts`**

```ts
import type { SchedulePlan } from "./types.ts";

export function renderCrontab(plans: SchedulePlan[]): string {
  if (plans.length === 0) return "";
  const lines = [
    "# GENERATED BY synccenter — do not edit",
    "# SchedulePlan → crontab fragment",
    "",
  ];
  for (const p of plans) {
    lines.push(`# ${p.folder} → ${p.anchor}`);
    lines.push(`${p.cron} ${p.command}`);
  }
  return lines.join("\n") + "\n";
}
```

- [ ] **Step 6: Generate the golden file and verify tests pass**

```bash
BUN_UPDATE_GOLDEN=1 bun test packages/apply-planner/test/render-crontab.test.ts
bun test packages/apply-planner/test/schedule.test.ts packages/apply-planner/test/render-crontab.test.ts
```
Expected: golden written, all tests pass on second run.

- [ ] **Step 7: Inspect the golden file**

```bash
cat packages/apply-planner/test/golden/crontab-example-code-projects.cron
```
Expected output:
```
# GENERATED BY synccenter — do not edit
# SchedulePlan → crontab fragment

# example-code-projects → qnap-ts453d
*/15 * * * * docker exec rclone-rcd rclone bisync /share/Sync/code gdrive:sync/code --filters-file=/share/synccenter-config/compiled/dev-monorepo/filter.rclone --resilient --recover --max-lock=2m --conflict-resolve=newer --conflict-loser=pathrename
```

- [ ] **Step 8: Typecheck + commit**

```bash
bun run --filter @synccenter/apply-planner typecheck
git add packages/apply-planner/
git commit -m "phase-2: apply-planner schedule builder + crontab renderer"
```

---

### Task 18: plan() — pure manifest compiler

**Files:**
- Create: `packages/apply-planner/src/plan.ts`
- Create: `packages/apply-planner/test/plan.test.ts`
- Create: `packages/apply-planner/test/golden/plan-test.json`
- Create: `packages/apply-planner/test/golden/plan-example-code-projects.json`
- Modify: `packages/apply-planner/src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "bun:test";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { plan } from "../src/plan.ts";
import { loadFolderManifest, loadAllHosts } from "../src/load.ts";

const FIX = join(import.meta.dir, "fixtures");
const GOLDEN_DIR = join(import.meta.dir, "golden");

function fixedSecretsResolver(map: Record<string, string>) {
  return { resolve: (ref: string) => map[ref] ?? `__missing:${ref}` };
}

const SECRETS = {
  "secrets/syncthing-api-keys.enc.yaml#mac-studio": "MAC-KEY",
  "secrets/syncthing-api-keys.enc.yaml#qnap-ts453d": "QNAP-KEY",
  "secrets/syncthing-api-keys.enc.yaml#win-desktop": "WIN-KEY",
  "secrets/syncthing-device-ids.enc.yaml#mac-studio": "MACDEV-MACDEV-MACDEV-MACDEV-MACDEV",
  "secrets/syncthing-device-ids.enc.yaml#qnap-ts453d": "QNAPDV-QNAPDV-QNAPDV-QNAPDV-QNAPDV",
  "secrets/syncthing-device-ids.enc.yaml#win-desktop": "WINDEV-WINDEV-WINDEV-WINDEV-WINDEV",
};

describe("plan", () => {
  it("plan(test) matches golden plan-test.json", () => {
    const folder = loadFolderManifest(join(FIX, "folders/test.yaml"));
    const hosts = loadAllHosts(join(FIX, "hosts"));
    const result = plan({
      folder,
      hosts,
      compiledIgnoreLines: [".DS_Store", "Thumbs.db", "*.tmp"],
      filtersFile: "",
      secrets: fixedSecretsResolver(SECRETS),
    });
    const path = join(GOLDEN_DIR, "plan-test.json");
    if (process.env["BUN_UPDATE_GOLDEN"] === "1" || !existsSync(path)) {
      writeFileSync(path, JSON.stringify(result, null, 2) + "\n", "utf8");
    }
    expect(JSON.parse(JSON.stringify(result))).toEqual(JSON.parse(readFileSync(path, "utf8")));
  });

  it("plan(example-code-projects) matches golden plan-example-code-projects.json (with schedule)", () => {
    const folder = loadFolderManifest(join(FIX, "folders/example-code-projects.yaml"));
    const hosts = loadAllHosts(join(FIX, "hosts"));
    const result = plan({
      folder,
      hosts,
      compiledIgnoreLines: ["**/node_modules/", "**/.env"],
      filtersFile: "/share/synccenter-config/compiled/dev-monorepo/filter.rclone",
      secrets: fixedSecretsResolver(SECRETS),
    });
    const path = join(GOLDEN_DIR, "plan-example-code-projects.json");
    if (process.env["BUN_UPDATE_GOLDEN"] === "1" || !existsSync(path)) {
      writeFileSync(path, JSON.stringify(result, null, 2) + "\n", "utf8");
    }
    expect(JSON.parse(JSON.stringify(result))).toEqual(JSON.parse(readFileSync(path, "utf8")));
  });

  it("throws PlanError(UNKNOWN_HOST) when paths references a host not in hosts/", () => {
    const folder = loadFolderManifest(join(FIX, "folders/test.yaml"));
    // Pretend we only know about mac-studio.
    const hosts = { "mac-studio": loadAllHosts(join(FIX, "hosts"))["mac-studio"]! };
    expect(() =>
      plan({ folder, hosts, compiledIgnoreLines: [], filtersFile: "", secrets: fixedSecretsResolver(SECRETS) }),
    ).toThrow(/UNKNOWN_HOST/);
  });

  it("throws PlanError(NO_CLOUD_EDGE_FOR_BISYNC) when no host has role: cloud-edge but folder has cloud:", () => {
    const folder = loadFolderManifest(join(FIX, "folders/example-code-projects.yaml"));
    const hosts = loadAllHosts(join(FIX, "hosts"));
    // Strip cloud-edge role from all hosts.
    for (const h of Object.values(hosts)) h.role = "mesh-node";
    expect(() =>
      plan({ folder, hosts, compiledIgnoreLines: [], filtersFile: "", secrets: fixedSecretsResolver(SECRETS) }),
    ).toThrow(/NO_CLOUD_EDGE_FOR_BISYNC/);
  });
});
```

- [ ] **Step 2: Confirm it fails**

```bash
bun test packages/apply-planner/test/plan.test.ts
```
Expected: module not found.

- [ ] **Step 3: Implement `src/plan.ts`**

```ts
import { mapPolicy } from "./conflict.ts";
import { buildSchedulePlan } from "./schedule.ts";
import { PlanError } from "./errors.ts";
import type { FolderManifest, HostManifest } from "./load.ts";
import type { ApplyPlan, HostName, SecretsResolver, SyncthingOp, SchedulePlan, SyncthingFolderConfig } from "./types.ts";

const FOLDER_TYPE_TO_WIRE: Record<FolderManifest["type"], SyncthingFolderConfig["type"]> = {
  "send-receive": "sendreceive",
  "send-only": "sendonly",
  "receive-only": "receiveonly",
  "receive-encrypted": "receiveencrypted",
};

export interface PlanArgs {
  folder: FolderManifest;
  hosts: Record<string, HostManifest>;
  compiledIgnoreLines: string[];
  filtersFile: string;
  secrets: SecretsResolver;
}

export function plan(args: PlanArgs): ApplyPlan {
  const { folder, hosts, compiledIgnoreLines, filtersFile, secrets } = args;

  // 1. Validate that every host referenced in paths exists.
  for (const hostName of Object.keys(folder.paths)) {
    if (!hosts[hostName]) {
      throw new PlanError(`folder ${folder.name} references unknown host: ${hostName}`, "UNKNOWN_HOST");
    }
  }

  // 2. If folder has cloud, find the anchor.
  let anchor: HostManifest | null = null;
  if (folder.cloud) {
    if (folder.cloud.anchor) {
      const named = hosts[folder.cloud.anchor];
      if (!named) {
        throw new PlanError(`cloud.anchor references unknown host: ${folder.cloud.anchor}`, "UNKNOWN_HOST");
      }
      anchor = named;
    } else {
      const cloudEdges = Object.values(hosts).filter((h) => h.role === "cloud-edge");
      if (cloudEdges.length === 0) {
        throw new PlanError(
          `folder ${folder.name} has cloud: but no host has role: cloud-edge`,
          "NO_CLOUD_EDGE_FOR_BISYNC",
        );
      }
      if (cloudEdges.length > 1) {
        throw new PlanError(
          `multiple hosts with role: cloud-edge (${cloudEdges.map((h) => h.name).join(", ")}); set cloud.anchor on the folder`,
          "MULTIPLE_CLOUD_EDGE",
        );
      }
      anchor = cloudEdges[0]!;
    }
  }

  // 3. Resolve device IDs and api keys for each participating host.
  const perHost: Record<HostName, SyncthingOp[]> = {};
  const allDeviceIds: { host: HostName; deviceID: string }[] = [];
  for (const hostName of Object.keys(folder.paths)) {
    const host = hosts[hostName]!;
    const deviceID = secrets.resolve(host.syncthing.device_id_ref);
    allDeviceIds.push({ host: hostName, deviceID });
  }

  // 4. Build per-host op lists.
  const policy = mapPolicy(folder.conflict?.policy);
  for (const hostName of Object.keys(folder.paths)) {
    const host = hosts[hostName]!;
    const localPath = folder.paths[hostName]!;
    const ov = folder.overrides?.[hostName] ?? {};
    const type = ov.type ?? folder.type;
    const ignorePerms = ov.ignore_perms ?? folder.ignore_perms;
    const fsWatcherEnabled = ov.fs_watcher_enabled ?? folder.fs_watcher_enabled;
    const fsWatcherDelay = ov.fs_watcher_delay_s ?? folder.fs_watcher_delay_s;

    const ops: SyncthingOp[] = [];
    // Add every OTHER host as a known device.
    for (const peer of allDeviceIds) {
      if (peer.host === hostName) continue;
      ops.push({
        kind: "addDevice",
        host: hostName as HostName,
        deviceID: peer.deviceID,
        name: peer.host,
      });
    }
    // Add the folder.
    const folderConfig: SyncthingFolderConfig = {
      id: folder.name,
      label: folder.name,
      path: localPath,
      type: FOLDER_TYPE_TO_WIRE[type],
      devices: allDeviceIds.map((d) => ({ deviceID: d.deviceID })),
      ...(ignorePerms !== undefined && { ignorePerms }),
      ...(fsWatcherEnabled !== undefined && { fsWatcherEnabled }),
      ...(fsWatcherDelay !== undefined && { fsWatcherDelayS: fsWatcherDelay }),
    };
    ops.push({ kind: "addFolder", host: hostName as HostName, folder: folderConfig });
    // Set ignores.
    ops.push({ kind: "setIgnores", host: hostName as HostName, folderId: folder.name, lines: compiledIgnoreLines });
    perHost[hostName] = ops;
    // Quiet unused vars (these are reserved for future conflict/policy patching):
    void host; void policy;
  }

  // 5. Build schedule.
  let schedule: SchedulePlan[] = [];
  if (anchor) {
    schedule = buildSchedulePlan(folder, anchor, filtersFile);
  }

  return {
    folder: folder.name,
    perHost,
    schedule,
    warnings: [],
  };
}
```

- [ ] **Step 4: Generate goldens + run tests**

```bash
BUN_UPDATE_GOLDEN=1 bun test packages/apply-planner/test/plan.test.ts
bun test packages/apply-planner/test/plan.test.ts
```
Expected: tests pass on second run.

- [ ] **Step 5: Spot-check the goldens**

```bash
cat packages/apply-planner/test/golden/plan-test.json | head -40
cat packages/apply-planner/test/golden/plan-example-code-projects.json | head -40
```
Verify: `perHost` has entries for each host, each entry contains addDevice + addFolder + setIgnores ops. `plan-example-code-projects.json` has a non-empty `schedule` array; `plan-test.json` has empty `schedule`.

- [ ] **Step 6: Update `src/index.ts`**

```ts
export { plan } from "./plan.ts";
export { renderCrontab } from "./render-crontab.ts";
export { mapPolicy } from "./conflict.ts";
export { buildSchedulePlan } from "./schedule.ts";
export { createSecretsResolver } from "./secrets.ts";
export { loadFolderManifest, loadHostManifest, loadAllHosts } from "./load.ts";
export type {
  ApplyPlan, ApplyOpts, ApplyResult, AdapterPool, DriftReport, HostApplyResult,
  HostName, FolderType, PlanContext, SchedulePlan, SecretsResolver, SyncthingFolderConfig,
  SyncthingFolderDevice, SyncthingOp,
} from "./types.ts";
export type { FolderManifest, HostManifest } from "./load.ts";
export { PlanError, DriftError, ApplyError } from "./errors.ts";
```

- [ ] **Step 7: Typecheck + commit**

```bash
bun run --filter @synccenter/apply-planner typecheck
git add packages/apply-planner/
git commit -m "phase-2: apply-planner plan() with golden file tests"
```

---

### Task 19: computeDelta — drift categorization

**Files:**
- Create: `packages/apply-planner/src/delta.ts`
- Create: `packages/apply-planner/test/delta.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "bun:test";
import { computeDelta } from "../src/delta.ts";
import type { ApplyPlan, SyncthingOp } from "../src/types.ts";

const PLAN: ApplyPlan = {
  folder: "test",
  perHost: {
    "mac-studio": [
      { kind: "addFolder", host: "mac-studio", folder: { id: "test", label: "test", path: "/p/mac", type: "sendreceive", devices: [{ deviceID: "X" }] } },
      { kind: "setIgnores", host: "mac-studio", folderId: "test", lines: [".DS_Store"] },
    ] as SyncthingOp[],
  },
  schedule: [],
  warnings: [],
};

describe("computeDelta", () => {
  it("classifies all ops as manifest-only when the folder doesn't exist on the host", () => {
    const delta = computeDelta(PLAN, {
      "mac-studio": { folder: null, ignores: null },
    });
    expect(delta.manifestOnly).toHaveLength(2);
    expect(delta.liveOnly).toHaveLength(0);
    expect(delta.divergent).toHaveLength(0);
  });

  it("returns liveOnly when live has a folder the plan doesn't (different folder id)", () => {
    const delta = computeDelta(PLAN, {
      "mac-studio": {
        folder: { id: "ghost", label: "ghost", path: "/p", type: "sendreceive", devices: [] },
        ignores: null,
      },
    });
    expect(delta.liveOnly).toEqual([{ host: "mac-studio", folderId: "ghost" }]);
  });

  it("returns divergent when path differs between plan and live", () => {
    const delta = computeDelta(PLAN, {
      "mac-studio": {
        folder: { id: "test", label: "test", path: "/WRONG", type: "sendreceive", devices: [{ deviceID: "X" }] },
        ignores: [".DS_Store"],
      },
    });
    expect(delta.divergent).toEqual([
      { host: "mac-studio", path: "perHost.mac-studio.folder.path", expected: "/p/mac", actual: "/WRONG" },
    ]);
  });

  it("returns DIVERGENT_IGNORES marker when ignore list differs", () => {
    const delta = computeDelta(PLAN, {
      "mac-studio": {
        folder: { id: "test", label: "test", path: "/p/mac", type: "sendreceive", devices: [{ deviceID: "X" }] },
        ignores: ["DIFFERENT"],
      },
    });
    expect(delta.divergent.some((d) => d.path.endsWith(".ignores"))).toBe(true);
  });
});
```

- [ ] **Step 2: Confirm it fails**

```bash
bun test packages/apply-planner/test/delta.test.ts
```
Expected: module not found.

- [ ] **Step 3: Implement `src/delta.ts`**

```ts
import type { ApplyPlan, DriftReport, HostName, SyncthingFolderConfig, SyncthingOp } from "./types.ts";

export interface LiveHostState {
  folder: SyncthingFolderConfig | null;
  ignores: string[] | null;
}

export type LiveState = Record<HostName, LiveHostState>;

export function computeDelta(p: ApplyPlan, live: LiveState): DriftReport {
  const manifestOnly: SyncthingOp[] = [];
  const liveOnly: { host: HostName; folderId: string }[] = [];
  const divergent: { host: HostName; path: string; expected: unknown; actual: unknown }[] = [];

  for (const host of Object.keys(p.perHost)) {
    const ops = p.perHost[host]!;
    const liveState = live[host];

    if (!liveState || !liveState.folder) {
      // Folder doesn't exist on the host at all — every op is manifest-only.
      manifestOnly.push(...ops);
      continue;
    }

    // Folder exists. Check if the id matches the plan.
    if (liveState.folder.id !== p.folder) {
      liveOnly.push({ host, folderId: liveState.folder.id });
      manifestOnly.push(...ops);
      continue;
    }

    // Folder exists with matching id; check addFolder field-by-field.
    const addFolderOp = ops.find((o) => o.kind === "addFolder");
    if (addFolderOp && addFolderOp.kind === "addFolder") {
      compareFolderFields(host, addFolderOp.folder, liveState.folder, divergent);
    }

    // Check ignores.
    const setIgnoresOp = ops.find((o) => o.kind === "setIgnores");
    if (setIgnoresOp && setIgnoresOp.kind === "setIgnores") {
      const expected = setIgnoresOp.lines;
      const actual = liveState.ignores ?? [];
      if (!arrayEq(stripMeta(expected), stripMeta(actual))) {
        divergent.push({
          host,
          path: `perHost.${host}.ignores`,
          expected,
          actual,
        });
      }
    }
  }

  return { manifestOnly, liveOnly, divergent };
}

function compareFolderFields(
  host: HostName,
  expected: SyncthingFolderConfig,
  actual: SyncthingFolderConfig,
  out: { host: HostName; path: string; expected: unknown; actual: unknown }[],
): void {
  const fields: (keyof SyncthingFolderConfig)[] = ["path", "type", "ignorePerms", "fsWatcherEnabled", "fsWatcherDelayS"];
  for (const f of fields) {
    const e = expected[f];
    const a = actual[f];
    if (e !== undefined && e !== a) {
      out.push({ host, path: `perHost.${host}.folder.${f}`, expected: e, actual: a });
    }
  }
}

function stripMeta(lines: string[]): string[] {
  return lines.filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
}

function arrayEq(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}
```

- [ ] **Step 4: Verify tests pass**

```bash
bun test packages/apply-planner/test/delta.test.ts
```
Expected: all 4 tests pass.

- [ ] **Step 5: Typecheck + commit**

```bash
bun run --filter @synccenter/apply-planner typecheck
git add packages/apply-planner/
git commit -m "phase-2: apply-planner computeDelta"
```

---

### Task 20: apply() — execute with adapters + per-host independence

**Files:**
- Create: `packages/apply-planner/src/apply.ts`
- Create: `packages/apply-planner/test/apply.test.ts`
- Modify: `packages/apply-planner/src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, mock } from "bun:test";
import { apply } from "../src/apply.ts";
import type { ApplyPlan, AdapterPool, SyncthingFolderConfig } from "../src/types.ts";

function makePool(perHost: Record<string, { addFolder: any; setIgnores: any; addDevice: any; patchFolder: any }>): AdapterPool {
  return {
    syncthing: (host) => ({
      addFolder: perHost[host]?.addFolder ?? (async () => undefined),
      setIgnores: perHost[host]?.setIgnores ?? (async () => undefined),
      addDevice: perHost[host]?.addDevice ?? (async () => undefined),
      patchFolder: perHost[host]?.patchFolder ?? (async () => undefined),
    } as any),
    rclone: () => ({} as any),
  };
}

const BASE_FOLDER: SyncthingFolderConfig = { id: "test", label: "test", path: "/p", type: "sendreceive", devices: [] };

const PLAN_TWO_HOSTS: ApplyPlan = {
  folder: "test",
  perHost: {
    "mac": [{ kind: "addFolder", host: "mac", folder: BASE_FOLDER }, { kind: "setIgnores", host: "mac", folderId: "test", lines: [".DS_Store"] }],
    "qnap": [{ kind: "addFolder", host: "qnap", folder: BASE_FOLDER }, { kind: "setIgnores", host: "qnap", folderId: "test", lines: [".DS_Store"] }],
  },
  schedule: [],
  warnings: [],
};

describe("apply", () => {
  it("executes operations in order per host and returns 'applied' status", async () => {
    const macAdd = mock(async () => undefined);
    const macSet = mock(async () => undefined);
    const pool = makePool({ "mac": { addFolder: macAdd, setIgnores: macSet, addDevice: async () => undefined, patchFolder: async () => undefined } });
    const res = await apply(PLAN_TWO_HOSTS, pool, {});
    expect(res.hosts.find((h) => h.host === "mac")?.status).toBe("applied");
    expect(macAdd).toHaveBeenCalledTimes(1);
    expect(macSet).toHaveBeenCalledTimes(1);
  });

  it("per-host independence: failure on one host does not abort the other", async () => {
    const pool = makePool({
      "mac": { addFolder: async () => { throw new Error("boom"); }, setIgnores: async () => undefined, addDevice: async () => undefined, patchFolder: async () => undefined },
      "qnap": { addFolder: async () => undefined, setIgnores: async () => undefined, addDevice: async () => undefined, patchFolder: async () => undefined },
    });
    const res = await apply(PLAN_TWO_HOSTS, pool, {});
    expect(res.hosts.find((h) => h.host === "mac")?.status).toBe("failed");
    expect(res.hosts.find((h) => h.host === "qnap")?.status).toBe("applied");
  });

  it("dryRun returns 'skipped' for every host and calls nothing", async () => {
    const macAdd = mock(async () => undefined);
    const pool = makePool({ "mac": { addFolder: macAdd, setIgnores: async () => undefined, addDevice: async () => undefined, patchFolder: async () => undefined } });
    const res = await apply(PLAN_TWO_HOSTS, pool, { dryRun: true });
    expect(res.hosts.every((h) => h.status === "skipped")).toBe(true);
    expect(macAdd).toHaveBeenCalledTimes(0);
  });
});
```

- [ ] **Step 2: Confirm it fails**

```bash
bun test packages/apply-planner/test/apply.test.ts
```
Expected: module not found.

- [ ] **Step 3: Implement `src/apply.ts`**

```ts
import type { AdapterPool, ApplyOpts, ApplyPlan, ApplyResult, HostApplyResult, HostName, SyncthingOp } from "./types.ts";

export async function apply(p: ApplyPlan, pool: AdapterPool, opts: ApplyOpts): Promise<ApplyResult> {
  const hosts: HostApplyResult[] = [];

  for (const host of Object.keys(p.perHost) as HostName[]) {
    const ops = p.perHost[host]!;
    if (opts.dryRun) {
      hosts.push({ host, status: "skipped", ops });
      continue;
    }
    try {
      await executeOps(host, ops, pool);
      hosts.push({ host, status: "applied", ops });
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      hosts.push({
        host,
        status: "failed",
        ops,
        error: { code: classify(err), message },
      });
    }
  }

  return {
    folder: p.folder,
    hosts,
    schedule: p.schedule,
    verified: false,
  };
}

async function executeOps(host: HostName, ops: SyncthingOp[], pool: AdapterPool): Promise<void> {
  const client = pool.syncthing(host);
  for (const op of ops) {
    switch (op.kind) {
      case "addDevice":
        await retry(() => client.addDevice({ deviceID: op.deviceID, name: op.name, addresses: op.addresses ?? ["dynamic"] }));
        break;
      case "addFolder":
        await retry(() => client.addFolder(op.folder));
        break;
      case "patchFolder":
        await retry(() => client.patchFolder(op.folderId, op.patch));
        break;
      case "setIgnores":
        await retry(() => client.setIgnores(op.folderId, op.lines));
        break;
      case "removeFolder":
        await retry(() => client.removeFolder(op.folderId));
        break;
    }
  }
}

async function retry<T>(fn: () => Promise<T>): Promise<T> {
  const delays = [500, 1000, 2000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number }).status;
      if (status && status >= 400 && status < 500) throw err; // no retry on 4xx
      if (attempt < delays.length) await sleep(delays[attempt]!);
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function classify(err: unknown): string {
  const status = (err as { status?: number }).status;
  if (typeof status === "number") {
    if (status >= 500) return "ADAPTER_5XX";
    if (status >= 400) return "ADAPTER_4XX";
  }
  const msg = (err as Error).message ?? "";
  if (msg.includes("timed out")) return "ADAPTER_TIMEOUT";
  if (msg.includes("network") || msg.includes("ECONN")) return "HOST_UNREACHABLE";
  return "ADAPTER_5XX";
}
```

- [ ] **Step 4: Verify tests pass**

```bash
bun test packages/apply-planner/test/apply.test.ts
```
Expected: all 3 tests pass.

- [ ] **Step 5: Update `src/index.ts`**

```ts
export { apply } from "./apply.ts";
// (keep existing exports)
```

- [ ] **Step 6: Typecheck + commit**

```bash
bun run --filter @synccenter/apply-planner typecheck
git add packages/apply-planner/
git commit -m "phase-2: apply-planner apply() with per-host independence"
```

---

### Task 21: verify() — read-back round trip

**Files:**
- Create: `packages/apply-planner/src/verify.ts`
- Create: `packages/apply-planner/test/verify.test.ts`
- Modify: `packages/apply-planner/src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "bun:test";
import { verify } from "../src/verify.ts";
import type { ApplyPlan, AdapterPool, SyncthingFolderConfig } from "../src/types.ts";

const FOLDER: SyncthingFolderConfig = { id: "test", label: "test", path: "/p/mac", type: "sendreceive", devices: [{ deviceID: "X" }] };

function poolWith(host: string, folder: SyncthingFolderConfig | null, ignores: string[] | null): AdapterPool {
  return {
    syncthing: () => ({
      getFolder: async () => folder,
      getIgnores: async () => ({ ignore: ignores ?? [] }),
    } as any),
    rclone: () => ({} as any),
  };
}

const PLAN: ApplyPlan = {
  folder: "test",
  perHost: {
    "mac": [{ kind: "addFolder", host: "mac", folder: FOLDER }, { kind: "setIgnores", host: "mac", folderId: "test", lines: [".DS_Store"] }],
  },
  schedule: [],
  warnings: [],
};

describe("verify", () => {
  it("returns verified=true when live state matches the plan", async () => {
    const res = await verify(PLAN, poolWith("mac", FOLDER, [".DS_Store"]));
    expect(res.verified).toBe(true);
    expect(res.report.divergent).toHaveLength(0);
  });

  it("returns verified=false when path differs", async () => {
    const res = await verify(PLAN, poolWith("mac", { ...FOLDER, path: "/wrong" }, [".DS_Store"]));
    expect(res.verified).toBe(false);
    expect(res.report.divergent.some((d) => d.path.endsWith(".path"))).toBe(true);
  });
});
```

- [ ] **Step 2: Confirm it fails**

```bash
bun test packages/apply-planner/test/verify.test.ts
```
Expected: module not found.

- [ ] **Step 3: Implement `src/verify.ts`**

```ts
import { computeDelta, type LiveState } from "./delta.ts";
import type { AdapterPool, ApplyPlan, DriftReport, HostName, SyncthingFolderConfig } from "./types.ts";

export interface VerifyResult {
  verified: boolean;
  report: DriftReport;
}

export async function verify(p: ApplyPlan, pool: AdapterPool): Promise<VerifyResult> {
  const live: LiveState = {};
  for (const host of Object.keys(p.perHost) as HostName[]) {
    const client = pool.syncthing(host);
    let folder: SyncthingFolderConfig | null = null;
    let ignores: string[] | null = null;
    try {
      folder = await client.getFolder(p.folder);
    } catch {
      folder = null;
    }
    if (folder) {
      try {
        const ig = await client.getIgnores(p.folder);
        ignores = ig.ignore ?? [];
      } catch {
        ignores = [];
      }
    }
    live[host] = { folder, ignores };
  }
  const report = computeDelta(p, live);
  const verified = report.divergent.length === 0 && report.liveOnly.length === 0;
  return { verified, report };
}
```

- [ ] **Step 4: Verify tests pass**

```bash
bun test packages/apply-planner/test/verify.test.ts
```
Expected: both tests pass.

- [ ] **Step 5: Update `src/index.ts`**

```ts
export { verify } from "./verify.ts";
export { computeDelta } from "./delta.ts";
// (keep existing exports)
```

- [ ] **Step 6: Run the full apply-planner suite**

```bash
bun test --cwd packages/apply-planner
```
Expected: every test passes (load, secrets, conflict, schedule, render-crontab, plan, delta, apply, verify).

- [ ] **Step 7: Typecheck + commit**

```bash
bun run --filter @synccenter/apply-planner typecheck
git add packages/apply-planner/
git commit -m "phase-2: apply-planner verify() round-trip"
```

---

### Task 22: sc folders plan + apply CLI subcommands

**Files:**
- Modify: `apps/cli/src/commands/folders.ts`
- Modify: `apps/cli/package.json` (add deps)

- [ ] **Step 1: Add deps**

In `apps/cli/package.json`, add to `dependencies`:

```json
"@synccenter/apply-planner": "workspace:*",
"@synccenter/state-importer": "workspace:*"
```

Then run `bun install` from repo root.

- [ ] **Step 2: Read the existing folders command structure**

Open `apps/cli/src/commands/folders.ts`. Identify the `registerFoldersCommand(program: Command)` pattern. The new subcommands should attach as `folders` subcommands using `.command("plan <name>")` and `.command("apply <name>")`.

- [ ] **Step 3: Add `plan` and `apply` subcommands**

In `apps/cli/src/commands/folders.ts`, alongside the existing subcommands, add:

```ts
import { plan as buildPlan, apply as applyPlan, computeDelta, loadFolderManifest, loadAllHosts, createSecretsResolver } from "@synccenter/apply-planner";
import { SyncthingClient } from "@synccenter/adapters/syncthing";
import { RcloneClient } from "@synccenter/adapters/rclone";
import { compile } from "@synccenter/rule-compiler";
import { readFileSync } from "fs";
import { join } from "path";

// inside registerFoldersCommand:

folders.command("plan <name>")
  .description("Compile a folder manifest into an ApplyPlan and print it")
  .option("--json", "emit machine-readable JSON")
  .action(async (name: string, cmdOpts: { json?: boolean }) => {
    const cfg = configDir();
    const folder = loadFolderManifest(join(cfg, "folders", `${name}.yaml`));
    const hosts = loadAllHosts(join(cfg, "hosts"));
    const secrets = createSecretsResolver({ configDir: cfg });
    const compiled = compile(join(cfg, "rules", `${folder.ruleset}.yaml`), {
      rulesetsDir: join(cfg, "rules"),
      importsDir: join(cfg, "imports"),
    });
    const ignoreLines = compiled.stignore.split("\n").filter((l) => l && !l.startsWith("#"));
    const filtersFile = join(cfg, "compiled", folder.ruleset, "filter.rclone");
    const p = buildPlan({ folder, hosts, compiledIgnoreLines: ignoreLines, filtersFile, secrets });
    if (cmdOpts.json) {
      process.stdout.write(JSON.stringify(p, null, 2) + "\n");
    } else {
      printPlanSummary(p);
    }
  });

folders.command("apply <name>")
  .description("Apply a folder manifest against the live mesh")
  .option("--dry-run", "compute the plan and the delta, but don't execute")
  .option("--prune", "remove folders/devices that exist live but not in the manifest")
  .option("--force", "override divergent-field protection")
  .action(async (name: string, cmdOpts: { dryRun?: boolean; prune?: boolean; force?: boolean }) => {
    const cfg = configDir();
    const folder = loadFolderManifest(join(cfg, "folders", `${name}.yaml`));
    const hosts = loadAllHosts(join(cfg, "hosts"));
    const secrets = createSecretsResolver({ configDir: cfg });
    const compiled = compile(join(cfg, "rules", `${folder.ruleset}.yaml`), {
      rulesetsDir: join(cfg, "rules"),
      importsDir: join(cfg, "imports"),
    });
    const ignoreLines = compiled.stignore.split("\n").filter((l) => l && !l.startsWith("#"));
    const filtersFile = join(cfg, "compiled", folder.ruleset, "filter.rclone");
    const p = buildPlan({ folder, hosts, compiledIgnoreLines: ignoreLines, filtersFile, secrets });

    const pool = buildAdapterPool(hosts, secrets);
    const live = await collectLiveState(p, pool);
    const delta = computeDelta(p, live);

    if (delta.liveOnly.length > 0 && !cmdOpts.prune) {
      process.stderr.write(`DRIFT: live-only folders detected: ${JSON.stringify(delta.liveOnly)} — pass --prune to remove.\n`);
      process.exit(2);
    }
    if (delta.divergent.length > 0 && !cmdOpts.force) {
      process.stderr.write(`DRIFT: divergent fields:\n${delta.divergent.map((d) => `  ${d.host} ${d.path}: expected ${JSON.stringify(d.expected)} actual ${JSON.stringify(d.actual)}`).join("\n")}\n  Pass --force to override or run \`sc state import\` to capture into YAML.\n`);
      process.exit(2);
    }

    const res = await applyPlan(p, pool, { dryRun: cmdOpts.dryRun, prune: cmdOpts.prune, force: cmdOpts.force });
    for (const h of res.hosts) {
      process.stdout.write(`${h.host}: ${h.status}${h.error ? ` (${h.error.code}: ${h.error.message})` : ""}\n`);
    }
  });

function printPlanSummary(p: ReturnType<typeof buildPlan>): void {
  process.stdout.write(`Plan for folder: ${p.folder}\n`);
  for (const host of Object.keys(p.perHost)) {
    process.stdout.write(`  ${host}: ${p.perHost[host]!.length} ops\n`);
    for (const op of p.perHost[host]!) {
      process.stdout.write(`    - ${op.kind}\n`);
    }
  }
  if (p.schedule.length > 0) {
    process.stdout.write(`  schedule:\n`);
    for (const s of p.schedule) process.stdout.write(`    ${s.cron} on ${s.anchor}\n`);
  }
  if (p.warnings.length > 0) {
    process.stdout.write(`  warnings:\n`);
    for (const w of p.warnings) process.stdout.write(`    ${w}\n`);
  }
}

function buildAdapterPool(hosts: Record<string, any>, secrets: { resolve: (r: string) => string }) {
  return {
    syncthing: (h: string) => {
      const host = hosts[h];
      return new SyncthingClient({ baseUrl: host.syncthing.api_url, apiKey: secrets.resolve(host.syncthing.api_key_ref) });
    },
    rclone: (h: string) => {
      const host = hosts[h];
      if (!host.rclone) throw new Error(`host ${h} has no rclone block`);
      return new RcloneClient({ baseUrl: host.rclone.rcd_url, auth: secrets.resolve(host.rclone.auth_ref) });
    },
  };
}

async function collectLiveState(p: ReturnType<typeof buildPlan>, pool: ReturnType<typeof buildAdapterPool>) {
  const out: Record<string, { folder: any; ignores: any }> = {};
  for (const host of Object.keys(p.perHost)) {
    const c = pool.syncthing(host);
    let folder = null;
    let ignores = null;
    try { folder = await c.getFolder(p.folder); } catch { /* ignore 404 */ }
    if (folder) {
      try { const ig = await c.getIgnores(p.folder); ignores = ig.ignore ?? []; } catch { ignores = []; }
    }
    out[host] = { folder, ignores };
  }
  return out;
}

function configDir(): string {
  return process.env["SC_CONFIG_DIR"] ?? "/Users/ericbaruch/Arik/dev/synccenter-config";
}
```

(The exact location of `configDir()` may already exist in `apps/cli/src/lib/config.ts`. Reuse the existing one if present; the helper above is a fallback.)

- [ ] **Step 4: Manual sanity smoke**

```bash
cd /Users/ericbaruch/Arik/dev/synccenter
bun apps/cli/src/index.ts folders plan test --json | head -20
```
Expected: prints a JSON `ApplyPlan` with non-empty `perHost`.

- [ ] **Step 5: Typecheck + commit**

```bash
bun run --filter @synccenter/cli typecheck
git add apps/cli/
git commit -m "phase-2: sc folders plan + apply subcommands"
```

---

### Task 23: sc state import CLI subcommand

**Files:**
- Create: `apps/cli/src/commands/state.ts`
- Modify: `apps/cli/src/index.ts`

- [ ] **Step 1: Write `apps/cli/src/commands/state.ts`**

```ts
import type { Command } from "commander";
import { importFolder, importHost, importAll, type HostInfo } from "@synccenter/state-importer";
import { loadAllHosts, createSecretsResolver } from "@synccenter/apply-planner";
import { join } from "path";

export function registerStateCommand(program: Command): void {
  const state = program.command("state").description("Import live mesh state into YAML manifests");
  const im = state.command("import").description("Import live state");

  im.command("folder <name>")
    .description("Import a single folder from the live mesh")
    .option("--write", "write changes to disk (default: diff and exit)")
    .action(async (name: string, opts: { write?: boolean }) => {
      const cfg = configDir();
      const hosts = buildHostInfo(cfg);
      const res = await importFolder(name, { configDir: cfg, hosts, write: opts.write });
      reportResult(res);
    });

  im.command("host <name>")
    .description("Import a single host's live state")
    .option("--write", "write changes to disk")
    .action(async (name: string, opts: { write?: boolean }) => {
      const cfg = configDir();
      const hosts = buildHostInfo(cfg);
      const target = hosts.find((h) => h.name === name);
      if (!target) {
        process.stderr.write(`unknown host: ${name}\n`);
        process.exit(1);
      }
      // importHost needs a HostShell; build it from the loaded manifest.
      const allHosts = loadAllHosts(join(cfg, "hosts"));
      const m = allHosts[name];
      if (!m) {
        process.stderr.write(`no manifest for host: ${name}\n`);
        process.exit(1);
      }
      const res = await importHost(
        {
          name: m.name,
          hostname: m.hostname,
          os: m.os,
          apiUrl: target.apiUrl,
          apiKey: target.apiKey,
          preserve: { role: m.role, syncthing: m.syncthing, ssh: m.ssh, ip: m.ip, rclone: m.rclone },
        },
        { configDir: cfg, hosts, write: opts.write },
      );
      reportResult(res);
    });

  im.command("all")
    .description("Import all folders and hosts")
    .option("--write", "write changes to disk")
    .action(async (opts: { write?: boolean }) => {
      const cfg = configDir();
      const hosts = buildHostInfo(cfg);
      const results = await importAll({ configDir: cfg, hosts, write: opts.write });
      for (const r of results) reportResult(r);
    });
}

function configDir(): string {
  return process.env["SC_CONFIG_DIR"] ?? "/Users/ericbaruch/Arik/dev/synccenter-config";
}

function buildHostInfo(cfg: string): HostInfo[] {
  const all = loadAllHosts(join(cfg, "hosts"));
  const secrets = createSecretsResolver({ configDir: cfg });
  return Object.values(all).map((h) => ({
    name: h.name,
    apiUrl: h.syncthing.api_url,
    apiKey: secrets.resolve(h.syncthing.api_key_ref),
  }));
}

function reportResult(r: { resource: { kind: string; name: string }; path: string; status: string; diff?: string }) {
  process.stdout.write(`${r.resource.kind}:${r.resource.name} → ${r.status} (${r.path})\n`);
  if (r.diff) process.stdout.write(r.diff + "\n");
  if (r.status === "would-change") process.exitCode = 1;
}
```

- [ ] **Step 2: Register the command in `apps/cli/src/index.ts`**

Add the import and registration:

```ts
import { registerStateCommand } from "./commands/state.ts";
// ...
registerStateCommand(program);
```

- [ ] **Step 3: Manual smoke**

```bash
SC_AGE_KEY_FILE=~/.config/sops/age/keys.txt SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt bun apps/cli/src/index.ts state import folder test
```
Expected: either prints "identical" (if previously imported) or shows a diff and exits 1.

- [ ] **Step 4: Typecheck + commit**

```bash
bun run --filter @synccenter/cli typecheck
git add apps/cli/
git commit -m "phase-2: sc state import folder|host|all"
```

---

### Task 24: sc schedule render CLI subcommand

**Files:**
- Create: `apps/cli/src/commands/schedule.ts`
- Modify: `apps/cli/src/index.ts`

- [ ] **Step 1: Write `apps/cli/src/commands/schedule.ts`**

```ts
import type { Command } from "commander";
import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  loadFolderManifest, loadAllHosts, createSecretsResolver,
  plan as buildPlan, renderCrontab,
} from "@synccenter/apply-planner";
import { compile } from "@synccenter/rule-compiler";

export function registerScheduleCommand(program: Command): void {
  const sch = program.command("schedule").description("Cron / schedule helpers");

  sch.command("render")
    .description("Render the QNAP crontab fragment for every folder with a cloud bisync")
    .option("--out <path>", "write to a file instead of stdout")
    .action(async (opts: { out?: string }) => {
      const cfg = configDir();
      const hosts = loadAllHosts(join(cfg, "hosts"));
      const secrets = createSecretsResolver({ configDir: cfg });

      const all = readdirSync(join(cfg, "folders"))
        .filter((f) => f.endsWith(".yaml") && !f.startsWith("example-") && f !== "README.md");

      const allSchedule = [];
      for (const f of all) {
        const folder = loadFolderManifest(join(cfg, "folders", f));
        if (!folder.cloud) continue;
        const compiled = compile(join(cfg, "rules", `${folder.ruleset}.yaml`), {
          rulesetsDir: join(cfg, "rules"),
          importsDir: join(cfg, "imports"),
        });
        const filtersFile = join(cfg, "compiled", folder.ruleset, "filter.rclone");
        const p = buildPlan({
          folder, hosts,
          compiledIgnoreLines: compiled.stignore.split("\n"),
          filtersFile,
          secrets,
        });
        allSchedule.push(...p.schedule);
      }

      const text = renderCrontab(allSchedule);
      if (opts.out) {
        writeFileSync(opts.out, text, "utf8");
      } else {
        process.stdout.write(text);
      }
    });
}

function configDir(): string {
  return process.env["SC_CONFIG_DIR"] ?? "/Users/ericbaruch/Arik/dev/synccenter-config";
}
```

- [ ] **Step 2: Register in `apps/cli/src/index.ts`**

```ts
import { registerScheduleCommand } from "./commands/schedule.ts";
// ...
registerScheduleCommand(program);
```

- [ ] **Step 3: Smoke test**

```bash
bun apps/cli/src/index.ts schedule render
```
Expected: prints the GENERATED header. With only `folders/test.yaml` present (no cloud block), the body is empty. If `example-code-projects.yaml` is renamed/active, a crontab line appears.

- [ ] **Step 4: Typecheck + commit**

```bash
bun run --filter @synccenter/cli typecheck
git add apps/cli/
git commit -m "phase-2: sc schedule render"
```

---

### Task 25: API endpoints — POST /folders/:name/plan + /apply

**Files:**
- Modify: `apps/api/src/routes/folders.ts`
- Modify: `apps/api/package.json` (add deps)

- [ ] **Step 1: Add deps**

In `apps/api/package.json`, add to `dependencies`:

```json
"@synccenter/apply-planner": "workspace:*",
"@synccenter/state-importer": "workspace:*"
```

Then run `bun install`.

- [ ] **Step 2: Add the two routes**

In `apps/api/src/routes/folders.ts`, alongside existing handlers, add:

```ts
import {
  plan as buildPlan, apply as applyPlan, computeDelta,
  loadFolderManifest, loadAllHosts, createSecretsResolver,
} from "@synccenter/apply-planner";
import { compile } from "@synccenter/rule-compiler";
import { SyncthingClient } from "@synccenter/adapters/syncthing";
import { RcloneClient } from "@synccenter/adapters/rclone";
import { join } from "path";

router.post("/:name/plan", async (req, res) => {
  try {
    const name = req.params.name;
    const cfg = process.env["SC_CONFIG_DIR"] ?? "/share/synccenter-config";
    const folder = loadFolderManifest(join(cfg, "folders", `${name}.yaml`));
    const hosts = loadAllHosts(join(cfg, "hosts"));
    const secrets = createSecretsResolver({ configDir: cfg });
    const compiled = compile(join(cfg, "rules", `${folder.ruleset}.yaml`), {
      rulesetsDir: join(cfg, "rules"),
      importsDir: join(cfg, "imports"),
    });
    const ignoreLines = compiled.stignore.split("\n").filter((l) => l && !l.startsWith("#"));
    const filtersFile = join(cfg, "compiled", folder.ruleset, "filter.rclone");
    const p = buildPlan({ folder, hosts, compiledIgnoreLines: ignoreLines, filtersFile, secrets });
    res.json({ plan: p });
  } catch (err) {
    res.status(400).json({ error: { code: (err as { code?: string }).code ?? "INTERNAL", message: (err as Error).message } });
  }
});

router.post("/:name/apply", async (req, res) => {
  try {
    if (!req.body?.confirm) {
      res.status(400).json({ error: { code: "CONFIRM_REQUIRED", message: "POST body must include { confirm: true }" } });
      return;
    }
    const { dryRun, prune, force } = req.body ?? {};
    const name = req.params.name;
    const cfg = process.env["SC_CONFIG_DIR"] ?? "/share/synccenter-config";
    const folder = loadFolderManifest(join(cfg, "folders", `${name}.yaml`));
    const hosts = loadAllHosts(join(cfg, "hosts"));
    const secrets = createSecretsResolver({ configDir: cfg });
    const compiled = compile(join(cfg, "rules", `${folder.ruleset}.yaml`), {
      rulesetsDir: join(cfg, "rules"),
      importsDir: join(cfg, "imports"),
    });
    const ignoreLines = compiled.stignore.split("\n").filter((l) => l && !l.startsWith("#"));
    const filtersFile = join(cfg, "compiled", folder.ruleset, "filter.rclone");
    const p = buildPlan({ folder, hosts, compiledIgnoreLines: ignoreLines, filtersFile, secrets });

    const pool = {
      syncthing: (h: string) => {
        const host = hosts[h]!;
        return new SyncthingClient({ baseUrl: host.syncthing.api_url, apiKey: secrets.resolve(host.syncthing.api_key_ref) });
      },
      rclone: (h: string) => {
        const host = hosts[h]!;
        if (!host.rclone) throw new Error(`host ${h} has no rclone block`);
        return new RcloneClient({ baseUrl: host.rclone.rcd_url, auth: secrets.resolve(host.rclone.auth_ref) });
      },
    };

    // Drift gate (same as CLI)
    const live: Record<string, { folder: unknown; ignores: unknown }> = {};
    for (const host of Object.keys(p.perHost)) {
      const c = pool.syncthing(host);
      let f = null;
      let ig = null;
      try { f = await c.getFolder(p.folder); } catch { /* */ }
      if (f) { try { const r = await c.getIgnores(p.folder); ig = r.ignore ?? []; } catch { ig = []; } }
      live[host] = { folder: f, ignores: ig };
    }
    const delta = computeDelta(p, live as never);
    if (delta.liveOnly.length > 0 && !prune) {
      res.status(409).json({ error: { code: "LIVE_ONLY", message: "pass prune:true to apply", details: delta.liveOnly } });
      return;
    }
    if (delta.divergent.length > 0 && !force) {
      res.status(409).json({ error: { code: "DIVERGENT", message: "pass force:true to apply", details: delta.divergent } });
      return;
    }
    const result = await applyPlan(p, pool, { dryRun, prune, force });
    res.json({ result, delta });
  } catch (err) {
    res.status(500).json({ error: { code: (err as { code?: string }).code ?? "INTERNAL", message: (err as Error).message } });
  }
});
```

- [ ] **Step 3: Add a tiny smoke test**

In `apps/api/test/api.test.ts` (existing file), append:

```ts
it("POST /folders/test/plan returns a plan", async () => {
  // Skip when SC_E2E is not set; this requires real secrets + config dir.
  if (process.env["SC_E2E"] !== "1") return;
  const res = await fetch(`${baseUrl}/folders/test/plan`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.plan.folder).toBe("test");
});
```

- [ ] **Step 4: Typecheck + commit**

```bash
bun run --filter @synccenter/api typecheck
git add apps/api/
git commit -m "phase-2: api POST /folders/:name/plan + /apply"
```

---

### Task 26: API endpoints — /state/import/* + /schedule/crontab

**Files:**
- Create: `apps/api/src/routes/state.ts`
- Create: `apps/api/src/routes/schedule.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Write `apps/api/src/routes/state.ts`**

```ts
import { Router } from "express";
import { join } from "path";
import { importFolder, importHost, importAll, type HostInfo } from "@synccenter/state-importer";
import { loadAllHosts, createSecretsResolver } from "@synccenter/apply-planner";

export const stateRouter = Router();

function cfg(): string {
  return process.env["SC_CONFIG_DIR"] ?? "/share/synccenter-config";
}

function buildHostInfo(): HostInfo[] {
  const all = loadAllHosts(join(cfg(), "hosts"));
  const secrets = createSecretsResolver({ configDir: cfg() });
  return Object.values(all).map((h) => ({
    name: h.name,
    apiUrl: h.syncthing.api_url,
    apiKey: secrets.resolve(h.syncthing.api_key_ref),
  }));
}

stateRouter.post("/import/folder/:name", async (req, res) => {
  try {
    const result = await importFolder(req.params.name, {
      configDir: cfg(),
      hosts: buildHostInfo(),
      write: req.body?.write === true,
    });
    res.json({ result });
  } catch (err) {
    res.status(400).json({ error: { code: (err as { code?: string }).code ?? "INTERNAL", message: (err as Error).message } });
  }
});

stateRouter.post("/import/host/:name", async (req, res) => {
  try {
    const all = loadAllHosts(join(cfg(), "hosts"));
    const m = all[req.params.name];
    if (!m) {
      res.status(404).json({ error: { code: "UNKNOWN_HOST", message: `no manifest for host: ${req.params.name}` } });
      return;
    }
    const secrets = createSecretsResolver({ configDir: cfg() });
    const result = await importHost(
      {
        name: m.name,
        hostname: m.hostname,
        os: m.os,
        apiUrl: m.syncthing.api_url,
        apiKey: secrets.resolve(m.syncthing.api_key_ref),
        preserve: { role: m.role, syncthing: m.syncthing, ssh: m.ssh, ip: m.ip, rclone: m.rclone },
      },
      { configDir: cfg(), hosts: buildHostInfo(), write: req.body?.write === true },
    );
    res.json({ result });
  } catch (err) {
    res.status(400).json({ error: { code: (err as { code?: string }).code ?? "INTERNAL", message: (err as Error).message } });
  }
});

stateRouter.post("/import/all", async (req, res) => {
  try {
    const results = await importAll({
      configDir: cfg(),
      hosts: buildHostInfo(),
      write: req.body?.write === true,
    });
    res.json({ results });
  } catch (err) {
    res.status(400).json({ error: { code: (err as { code?: string }).code ?? "INTERNAL", message: (err as Error).message } });
  }
});
```

- [ ] **Step 2: Write `apps/api/src/routes/schedule.ts`**

```ts
import { Router } from "express";
import { readdirSync } from "fs";
import { join } from "path";
import {
  loadFolderManifest, loadAllHosts, createSecretsResolver,
  plan as buildPlan, renderCrontab,
} from "@synccenter/apply-planner";
import { compile } from "@synccenter/rule-compiler";

export const scheduleRouter = Router();

scheduleRouter.get("/crontab", async (_req, res) => {
  try {
    const cfg = process.env["SC_CONFIG_DIR"] ?? "/share/synccenter-config";
    const hosts = loadAllHosts(join(cfg, "hosts"));
    const secrets = createSecretsResolver({ configDir: cfg });

    const all = readdirSync(join(cfg, "folders"))
      .filter((f) => f.endsWith(".yaml") && !f.startsWith("example-") && f !== "README.md");

    const allSchedule = [];
    for (const f of all) {
      const folder = loadFolderManifest(join(cfg, "folders", f));
      if (!folder.cloud) continue;
      const compiled = compile(join(cfg, "rules", `${folder.ruleset}.yaml`), {
        rulesetsDir: join(cfg, "rules"),
        importsDir: join(cfg, "imports"),
      });
      const filtersFile = join(cfg, "compiled", folder.ruleset, "filter.rclone");
      const p = buildPlan({
        folder, hosts,
        compiledIgnoreLines: compiled.stignore.split("\n"),
        filtersFile,
        secrets,
      });
      allSchedule.push(...p.schedule);
    }

    const text = renderCrontab(allSchedule);
    res.type("text/plain").send(text);
  } catch (err) {
    res.status(500).type("text/plain").send(`# error: ${(err as Error).message}\n`);
  }
});
```

- [ ] **Step 3: Register both routers in `apps/api/src/app.ts`**

```ts
import { stateRouter } from "./routes/state.ts";
import { scheduleRouter } from "./routes/schedule.ts";
// inside the function that builds the app:
app.use("/state", stateRouter);
app.use("/schedule", scheduleRouter);
```

- [ ] **Step 4: Typecheck + commit**

```bash
bun run --filter @synccenter/api typecheck
git add apps/api/
git commit -m "phase-2: api /state/import/* + /schedule/crontab"
```

---

### Task 27: End-to-end smoke + idempotency check

**Files:** (no new files; this is a verification step)

- [ ] **Step 1: Run full typecheck + tests at the workspace level**

```bash
cd /Users/ericbaruch/Arik/dev/synccenter
bun typecheck
bun test
```
Expected: both green for every package. If any failures, fix in the relevant Task above and rerun.

- [ ] **Step 2: Run `sc state import folder test` twice — idempotency check**

```bash
export SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt
export SC_CONFIG_DIR=/Users/ericbaruch/Arik/dev/synccenter-config

bun apps/cli/src/index.ts state import folder test --write
# Inspect any diff; commit the write if you accept it:
cd /Users/ericbaruch/Arik/dev/synccenter-config
git diff folders/test.yaml
git checkout folders/test.yaml   # if you don't want the change
cd /Users/ericbaruch/Arik/dev/synccenter

# Second run — must be identical
bun apps/cli/src/index.ts state import folder test
```
Expected: second invocation exits 0 with `folder:test → identical`.

- [ ] **Step 3: Run `sc folders plan test` and inspect output**

```bash
bun apps/cli/src/index.ts folders plan test --json | head -30
```
Expected: JSON `ApplyPlan` containing addDevice/addFolder/setIgnores ops for each host the test folder lives on.

- [ ] **Step 4: Run `sc folders apply test --dry-run` — must produce zero deltas**

```bash
bun apps/cli/src/index.ts folders apply test --dry-run
```
Expected: prints `mac-studio: skipped`, `qnap-ts453d: skipped`, `win-desktop: skipped` (no drift error).

If drift is reported: run `sc state import folder test --write`, commit in `synccenter-config`, and retry.

- [ ] **Step 5: Run `sc schedule render`**

```bash
bun apps/cli/src/index.ts schedule render
```
Expected: prints empty header (no folder has `cloud:`) or a real crontab line if `example-code-projects.yaml` was promoted out of the `example-` prefix.

- [ ] **Step 6: Commit any incidental fixes**

```bash
cd /Users/ericbaruch/Arik/dev/synccenter
git status
# If there are any straggler changes (e.g. updated fixtures), commit them.
git add -p
git commit -m "phase-2: post-integration tweaks"
```

- [ ] **Step 7: Tag exit**

```bash
git tag phase-2-complete
cd /Users/ericbaruch/Arik/dev/synccenter-config
git tag phase-2-complete
```

Phase 2 exit criteria from the spec:

1. `bun typecheck` + `bun test` green ✅ (Step 1)
2. `sc state import folder test --write` idempotent ✅ (Step 2)
3. `sc state import host <name> --write` idempotent — repeat Step 2 with each host name
4. `sc folders apply test --dry-run` produces zero deltas ✅ (Step 4)
5. `sc folders apply example-code-projects --dry-run` produces expected plan (run if you have promoted that folder)
6. `sc schedule render` produces correct crontab fragment ✅ (Step 5)
7. Schema validates every file in `synccenter-config/folders/` and `hosts/` — covered by ajv use in `loadAllHosts`/`loadFolderManifest`; verified during Task 22 sanity smoke
8. `hosts/qnap-ts453d.yaml` carries `role: cloud-edge` ✅ (Task 3)
9. (Optional) `SC_E2E=1 bun test:e2e` runs an apply against the live `test` folder — out of scope for this plan; operator-gated

---

## Notes for the engineer

- **Pre-flight: confirm adapter surface.** Before Task 12, verify the `SyncthingClient` in `packages/adapters/src/syncthing/client.ts` has these methods used downstream: `getFolder(id)`, `getFolders()`, `getIgnores(id)`, `addDevice({ deviceID, name, addresses })`, `patchFolder(id, patch)`, `removeFolder(id)`, `getStatus()`. The package is described as a complete REST client and tests cover `addFolder`/`setIgnores`/`scan`/`pause`/`resume`/`events`/`getVersion`, so the rest are very likely present — but if any are missing, add them as a tiny preliminary commit (`phase-2: adapters - add <method>`) before continuing. Match the existing client's pattern: timeout-aware `fetch`, `X-API-Key` header, JSON body for write endpoints, throw `SyncthingError` with status on 4xx/5xx.
- **BISYNC_NEEDS_RESYNC** is defined as an error code in Task 13 but the detection logic is deferred to a future task that introduces `sc folders bisync init <name>`. Phase 2 `apply()` does not execute bisync — it only sets up Syncthing config and writes the crontab schedule; the cron tick runs bisync later. The error code is reserved for the day we add the init command.
- **Verbose-mode `redact()`** from the spec is also deferred: the CLI has no verbose mode yet, and no current code path logs secret values. When verbose mode is added (Phase 3+), introduce a `redact(message: string, secrets: SecretsResolver): string` helper that scans for known secret values and replaces with `REDACTED`.
- **Test-first.** Every code task starts by writing the test, confirming it fails, then making it pass. Don't skip the "confirm it fails" step — it catches the case where the test wasn't actually exercising the new code.
- **No partial commits.** Each task ends with a commit. Don't merge two tasks into one commit; the granularity is there so failures are easy to back out.
- **Type imports.** Because `verbatimModuleSyntax` is on, use `import type { ... }` for types.
- **Path resolution for the schema.** `packages/apply-planner/src/load.ts` resolves schema files via a relative `../../schema` path. If you find yourself fighting paths, switch to importing the JSON via TypeScript's `resolveJsonModule` (already on) and a workspace-qualified `import folderSchema from "@synccenter/schema/folder.schema.json" with { type: "json" }`. Either works; pick the one whose error messages are clearest in your shell.
- **Secrets in tests.** Never invoke real sops in unit tests. Pass a `spawn` injection (see Task 15) and assert on the argv.
- **Idempotency.** If a test asserts that two invocations produce identical output, prefer comparing the YAML strings (not the parsed objects) so canonical-emit drift is caught.
- **Adapter call signatures.** Read the adapter clients before writing `apply.ts` — confirm that `client.addFolder({ ... })` matches what the existing tests in `packages/adapters/test/syncthing.test.ts` exercise (`POST /rest/config/folders`).
- **No new files outside the file map.** If you need a new module that wasn't planned, add it as a new task at the end of the plan and adjust task numbers; don't sneak it into an unrelated commit.
