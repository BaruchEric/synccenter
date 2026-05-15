# Phase 2 — Apply-Planner + State-Importer

**Date:** 2026-05-15
**Status:** Approved — ready for implementation plan
**Predecessors:** [`docs/SyncCenter-Project-Plan.md`](../../SyncCenter-Project-Plan.md), [`docs/runbooks/phase-1-bringup.md`](../../runbooks/phase-1-bringup.md)
**Scope owner:** Eric

## Why this is "Phase 2" (and what it is not)

This spec re-frames "Phase 2" from the original project plan.

The original plan's Phase 2 was the **rule engine** — turning ruleset YAML into `.stignore` and `filter.rclone`. That work is **already done**: `packages/rule-compiler` and `packages/importers` ship with tests and produce committed `compiled/<ruleset>/{.stignore, filter.rclone}` files in `synccenter-config/`.

This Phase 2 is the **layer above** — the missing piece between a committed folder manifest and live mesh state:

- A **manifest compiler** (`packages/apply-planner`): folder + host + ruleset manifests → typed `ApplyPlan` (Syncthing REST operations + rclone bisync schedule entries).
- A **reverse importer** (`packages/state-importer`): live mesh state → canonical YAML, diff-by-default, idempotent.

The existing `packages/rule-compiler` (ruleset → ignore files) keeps its name and job. The new packages sit above it and consume its output.

### What's already live (Phase 1 complete, do not redo)

- Syncthing v2.1.0 mesh across mac-studio, qnap-ts453d, win-desktop with one shared folder (`test`).
- rclone OAuth + remote on each host (gdrive root = SyncCenter folder in My Drive).
- sops-sealed identities committed to `synccenter-config/secrets/`.
- `synccenter-config/folders/test.yaml`, `hosts/{mac-studio,qnap-ts453d,win-desktop}.yaml`, `rules/{base-binaries,dev-monorepo}.yaml` all committed.
- `packages/rule-compiler`, `packages/importers`, `packages/adapters` (Syncthing + rclone REST clients), `packages/schema`, `apps/api` skeleton, `apps/cli` skeleton, `apps/mcp`, `apps/web` skeleton — all coded, mostly tested. Phase 2 work integrates with these, does not replace them.

## Design decisions (the six open questions, resolved)

| # | Question | Decision |
|---|----------|----------|
| Q1 | Rule expression model | **Static.** `paths` stays a flat `{host: path}` map. Add optional `overrides: { [hostName]: PartialFolderFields }` for genuine per-host scalar differences (`type`, `ignore_perms`, `fs_watcher_*`). No templating, no matrix, no computed paths. YAGNI for 3 hosts. |
| Q2 | Conflict resolution | **Unified per-folder vocabulary.** Add `conflict: { policy, surface_to_ui }` where `policy ∈ {newer, older, keep-both, require-resolve}`. Compiler maps each policy to Syncthing + rclone-bisync flags. Engine-specific flag escape hatch remains via existing `cloud.bisync.flags` and `engine_overrides`. |
| Q3 | Cloud bisync anchor | **Host carries `role: cloud-edge`.** Compiler picks the cloud-edge host as the anchor for every folder's bisync. Errors if zero or >1 hosts carry the role. Optional `cloud.anchor: <hostName>` on folders for future multi-cloud-edge tiebreaking — added only when actually needed. |
| Q4 | Scheduler contract | **Neutral `SchedulePlan[]` data + crontab renderer in Phase 2.** Daemon-based scheduling (in-process via rclone rcd `_async`) is the likely Phase 3 path; both render from the same `SchedulePlan[]`. |
| Q5 | Drift detection | **Refuse-to-apply by default.** Apply computes a delta with three categories: `manifest-only` (always safe), `live-only` (requires `--prune`), `divergent` (requires `--force`). No silent destruction of live state. |
| Q6 | Reverse importer | **Per-resource, canonical YAML, diff-by-default.** Three operations: `importFolder(name)`, `importHost(name)`, `importAll()`. Output is byte-deterministic given live state. Default: print diff and exit 1 if on-disk YAML differs. `--write` overwrites. |

## Architecture

```
            ┌──────────────────────────────────────────────────┐
            │            synccenter-config/                    │
            │   folders/*.yaml   hosts/*.yaml   rules/*.yaml   │
            │   schedules/*.yaml secrets/*.enc.*               │
            │   compiled/<rs>/.stignore + filter.rclone        │
            └─────────────────────┬────────────────────────────┘
                                  │ read
        ┌─────────────────────────┴───────────────────────────┐
        │                                                     │
        ▼                                                     ▼
┌────────────────────┐                          ┌──────────────────────┐
│ packages/          │                          │ packages/            │
│ rule-compiler      │  ruleset → .stignore +   │ apply-planner   NEW  │
│ (already done)     │  filter.rclone           │                      │
└────────────────────┘                          │ folders × hosts ×    │
                                                │ compiled-rules       │
                                                │     ↓                │
                                                │ ApplyPlan (typed)    │
                                                │   - SyncthingOp[]    │
                                                │     per host         │
                                                │   - SchedulePlan[]   │
                                                │ + crontab renderer   │
                                                └─────────┬────────────┘
                                                          │
                                  ┌───────────────────────┼───────────────────────┐
                                  │                       │                       │
                                  ▼                       ▼                       ▼
                       ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐
                       │ apps/cli           │  │ apps/api           │  │ packages/          │
                       │  sc folders plan   │  │ /folders/:n/plan   │  │ state-importer NEW │
                       │  sc folders apply  │  │ /folders/:n/apply  │  │                    │
                       │  sc state import   │  │                    │  │ live → canonical   │
                       │                    │  │                    │  │ YAML strings       │
                       └─────────┬──────────┘  └─────────┬──────────┘  └─────────┬──────────┘
                                 │                       │                       │
                                 └───────────────────────┼───────────────────────┘
                                                         ▼
                                              ┌─────────────────────┐
                                              │ packages/adapters   │
                                              │ (Syncthing + rclone │
                                              │  REST clients,      │
                                              │  already done)      │
                                              └──────────┬──────────┘
                                                         ▼
                                              ┌─────────────────────┐
                                              │ Live mesh           │
                                              │ Mac · QNAP · Win    │
                                              │ + GDrive            │
                                              └─────────────────────┘
```

### Three operations, three guarantees

| Operation | Pure? | Network? | Secrets? | Tested with |
|---|---|---|---|---|
| **compile** (`apply-planner.plan`) | yes | no | no | golden files |
| **apply** (`apply-planner.apply`) | no | yes | yes | mocked adapters + one gated e2e |
| **import** (`state-importer.*`) | side-reading only | yes | yes | mocked adapters + golden files |

The compile step is pure so its output can be reviewed in CI without host access. The apply step is the only side-effecting boundary; it resolves secrets at the last moment.

## Data flow — `sc folders apply test`

```
1. sc folders apply test
       │
       ▼
2. Load manifests (sync)
   - folders/test.yaml          (yaml.parse + schema validate via ajv)
   - hosts/*.yaml               (yaml.parse + schema validate via ajv)
   - rules/<ruleset>.yaml       (handed off to existing rule-compiler)
       │
       ▼
3. Compile rules                (existing packages/rule-compiler)
   - emits .stignore + filter.rclone for the folder's ruleset
       │
       ▼
4. Plan apply                   (NEW packages/apply-planner)
   - resolves device_id_ref → device IDs (sops decrypt happens here)
   - resolves api_key_ref     → api keys
   - identifies cloud-edge host (anchor) via host.role
   - emits ApplyPlan = { perHost: { ... }, schedule: [ ... ], warnings: [...] }
       │
       ▼
5. Fetch live state             (via packages/adapters)
   - GET /rest/config/folders/test from each host in folder.paths
   - GET /rest/db/ignores?folder=test from each host
   - compute delta vs ApplyPlan
       │
       ▼
6. Drift gate                   (per Q5)
   - manifest-only:  apply
   - live-only:      refuse unless --prune
   - divergent:      refuse unless --force
   - --dry-run:      stop here, print plan + delta
       │
       ▼
7. Execute ApplyPlan            (via packages/adapters)
   - per-host SyncthingOp[] in order:
       addDevice → addFolder → setIgnores → patchFolder (versioning, etc.)
   - schedule writes: render crontab fragment for the cloud-edge host
       │
       ▼
8. Verify                       (read-back via packages/adapters)
   - Each host's /rest/config/folders/test now matches the plan
   - .stignore round-trips via /rest/db/ignores
```

## Data flow — `sc state import folder test`

```
1. sc state import folder test
       │
       ▼
2. Load hosts/*.yaml + decrypt sops refs at runtime
       │
       ▼
3. Adapter reads (via packages/adapters):
   - For each host: GET /rest/config/folders/test (if present)
   - For each host: GET /rest/db/ignores?folder=test
       │
       ▼
4. Synthesize canonical YAML    (NEW packages/state-importer)
   - Union per-host paths
   - Detect ruleset by comparing live ignores to known rulesets' compiled .stignore
   - On match → use that ruleset name
   - On no match → emit ruleset: imported-<folder>
                  + write rules/imported-<folder>.yaml with the live patterns
   - Stable key order, stable indent, deterministic output
       │
       ▼
5. Diff vs on-disk YAML
   - identical → exit 0, no-op, status: "identical"
   - different + no --write → print unified diff, exit 1, status: "would-change"
   - different + --write   → write the new content, exit 0, status: "written"
```

## Components

### `packages/apply-planner` (new)

```
packages/apply-planner/
├── package.json            // depends on @synccenter/schema, @synccenter/rule-compiler, @synccenter/adapters, yaml
├── src/
│   ├── index.ts            // public surface
│   ├── types.ts            // ApplyPlan, SyncthingOp, SchedulePlan, DriftReport, PlanContext
│   ├── errors.ts           // PlanError, ApplyError, DriftError + code enums
│   ├── load.ts             // loadFolderManifest, loadHostManifest, loadAllHosts (yaml + ajv)
│   ├── secrets.ts          // resolveRef("secrets/...#key") → string (sops shell-out, in-process cache)
│   ├── plan.ts             // plan(folder, hosts, ruleset, compiledRules, secretsResolver) → ApplyPlan
│   ├── conflict.ts         // mapPolicy(policy) → { syncthingMaxConflicts, rcloneFlags[] }
│   ├── schedule.ts         // buildSchedulePlan(folder, anchorHost) → SchedulePlan
│   ├── render-crontab.ts   // renderCrontab(SchedulePlan[]) → string
│   ├── delta.ts            // computeDelta(plan, liveState) → DriftReport
│   ├── apply.ts            // apply(plan, adapters, opts) → ApplyResult
│   └── verify.ts           // verify(plan, adapters) → VerifyResult
└── test/
    ├── plan.test.ts        // golden files: real test.yaml + hosts → fixed ApplyPlan JSON
    ├── conflict.test.ts    // each policy → engine-specific output
    ├── render-crontab.test.ts
    ├── delta.test.ts       // each drift category
    └── fixtures/...
```

**Public surface (`index.ts`):**

```ts
export { plan } from "./plan.ts";
export { apply } from "./apply.ts";
export { computeDelta } from "./delta.ts";
export { renderCrontab } from "./render-crontab.ts";
export { resolveRef } from "./secrets.ts";
export type {
  ApplyPlan,
  SyncthingOp,
  SchedulePlan,
  DriftReport,
  PlanContext,
  ApplyOpts,
  ApplyResult,
} from "./types.ts";
export { PlanError, ApplyError, DriftError } from "./errors.ts";
```

**Key types:**

```ts
type HostName = string;

type SyncthingOp =
  | { kind: "addDevice"; host: HostName; deviceID: string; name: string; addresses?: string[] }
  | { kind: "addFolder"; host: HostName; folder: SyncthingFolderConfig }
  | { kind: "patchFolder"; host: HostName; folderId: string; patch: Partial<SyncthingFolderConfig> }
  | { kind: "setIgnores"; host: HostName; folderId: string; lines: string[] }
  | { kind: "removeFolder"; host: HostName; folderId: string };     // only emitted under --prune

type SchedulePlan = {
  anchor: HostName;             // host that runs the command
  folder: string;
  cron: string;                 // 5-field cron
  command: string;              // full rclone bisync invocation
  filtersFile: string;          // absolute path on anchor
};

type ApplyPlan = {
  folder: string;
  perHost: Record<HostName, SyncthingOp[]>;  // insertion order = execution order
  schedule: SchedulePlan[];                  // empty if no cloud edge
  warnings: string[];                        // e.g. divergent rules from rule-compiler
};

type DriftReport = {
  manifestOnly: SyncthingOp[];                                      // safe
  liveOnly: { host: HostName; folderId: string }[];                 // --prune
  divergent: { host: HostName; path: string; expected: unknown; actual: unknown }[]; // --force
};
```

**`plan()` is pure.** No network, no side effects. Tested via golden files where the input is a fixture copy of real manifests and the expected output is a committed JSON file.

**`apply()` consumes a plan plus adapter instances** and executes per-host operations in order. Each op call has retry-on-transient-error semantics with a hard ceiling (see Network failures below). Per-host failure does not abort other hosts.

### `packages/state-importer` (new)

```
packages/state-importer/
├── package.json            // depends on @synccenter/schema, @synccenter/adapters, yaml
├── src/
│   ├── index.ts
│   ├── types.ts            // ImportResult, ImportOpts
│   ├── errors.ts           // ImportError + code enum
│   ├── canonical.ts        // canonical YAML emit: sorted keys, fixed indent, deterministic
│   ├── ruleset-match.ts    // live ignore lines + known rulesets → best ruleset name or null
│   ├── import-folder.ts    // importFolder(name, opts) → ImportResult
│   ├── import-host.ts      // importHost(name, opts) → ImportResult
│   ├── import-all.ts       // importAll(opts) → ImportResult[]
│   └── diff.ts             // unified-diff helper for diff-default output
└── test/
    ├── canonical.test.ts   // round-trip property + stability across re-emits
    ├── ruleset-match.test.ts
    ├── import-folder.test.ts  // mocked adapters; byte-identical YAML on re-import
    └── fixtures/...
```

**Public surface:**

```ts
export { importFolder } from "./import-folder.ts";
export { importHost } from "./import-host.ts";
export { importAll } from "./import-all.ts";
export { canonicalEmit } from "./canonical.ts";
export type { ImportResult, ImportOpts } from "./types.ts";
export { ImportError } from "./errors.ts";
```

**`ImportResult`:**

```ts
type ImportResult = {
  resource: { kind: "folder" | "host"; name: string };
  path: string;            // target yaml path
  status: "identical" | "would-change" | "written";
  diff?: string;           // unified diff when would-change or written
};
```

**Canonical emit** sorts top-level keys to schema order, sorts nested keys alphabetically, uses 2-space indent, no flow style, no anchors. This is the structural idempotency guarantee.

### Schema fixes (`packages/schema`)

Folded into Phase 2:

1. **`host.schema.json`** — extend the `syncthing` block:
   - `install_method` enum: add `"winget+nssm"`.
   - Add optional `binary_path: string` and `home_dir: string` (used by Windows installs).
   - (Reason: `hosts/win-desktop.yaml` currently fails validation against the existing schema.)
2. **`host.schema.json`** — `role` already includes `cloud-edge`; add inline description that exactly one host should carry it (the bisync anchor).
3. **`folder.schema.json`** — add `conflict: { policy, surface_to_ui }` (Q2).
4. **`folder.schema.json`** — add `overrides: { [hostName]: Partial<FolderFields> }` (Q1).
5. **`folder.schema.json`** — add optional `cloud.anchor: <hostName>` (Q3 future-proofing).

Existing example folders that use raw rclone flags via `cloud.bisync.flags` keep working — the new `conflict:` block is additive, not replacing.

### `apps/cli` additions

```
sc folders plan <name> [--json]
   → calls plan(); prints ApplyPlan summary (or JSON).

sc folders apply <name> [--dry-run] [--prune] [--force]
   → calls plan() then computeDelta() then apply().
   → --dry-run stops after delta with a printed plan + drift report.

sc state import folder <name> [--write]
sc state import host <name> [--write]
sc state import all [--write]
   → diff-default. --write overwrites.

sc schedule render [--out=<path>]
   → renders the crontab fragment for the cloud-edge host. Default stdout.
```

The existing `sc folders` command (`apps/cli/src/commands/folders.ts`) gets these new sub-commands added; the old surface keeps its meaning.

### `apps/api` additions

```
POST /folders/:name/plan        → ApplyPlan + DriftReport
POST /folders/:name/apply       → ApplyResult (body: { dryRun, prune, force, confirm })
POST /state/import/folder/:name → ImportResult (body: { write })
POST /state/import/host/:name   → ImportResult (body: { write })
POST /state/import/all          → ImportResult[] (body: { write })
GET  /schedule/crontab          → text/plain crontab fragment
```

Auth via the existing bearer-token middleware (`apps/api/src/auth.ts`). All mutating endpoints require `confirm: true` flag in the body for parity with the MCP design point from §8 of the project plan.

## Error handling

### Taxonomy

Four error classes, each with a stable `.code` field for programmatic handling.

```ts
class PlanError    extends Error { code: PlanErrorCode }
class DriftError   extends Error { code: DriftErrorCode; report: DriftReport }
class ApplyError   extends Error { code: ApplyErrorCode; partial?: ApplyResult }
class ImportError  extends Error { code: ImportErrorCode }
```

| Class | Codes | Recoverable? |
|---|---|---|
| `PlanError` | `MANIFEST_NOT_FOUND`, `SCHEMA_INVALID`, `UNKNOWN_HOST`, `MISSING_RULESET`, `MULTIPLE_CLOUD_EDGE`, `NO_CLOUD_EDGE_FOR_BISYNC`, `SECRET_REF_INVALID`, `SOPS_DECRYPT_FAILED` | No — fix YAML or secrets |
| `DriftError` | `LIVE_ONLY_FOLDER` (`--prune`), `LIVE_ONLY_DEVICE` (`--prune`), `DIVERGENT_FIELD` (`--force`), `DIVERGENT_IGNORES` (`--force`) | Yes — override flag or `sc state import` |
| `ApplyError` | `HOST_UNREACHABLE`, `ADAPTER_TIMEOUT`, `ADAPTER_4XX`, `ADAPTER_5XX`, `VERIFY_FAILED`, `BISYNC_NEEDS_RESYNC` | Yes — retry; per-host failures don't abort other hosts |
| `ImportError` | `HOST_UNREACHABLE`, `FOLDER_NOT_PRESENT_ANYWHERE`, `RULESET_AMBIGUOUS`, `WRITE_BLOCKED` (target changed since diff) | Yes — operator decides |

### Invariants

- **No error is silent.** Every error class carries enough structured context to render a useful CLI message and a JSON `{error: {code, message, details}}` body for the API. No bare-string throws.
- **No partial state is hidden.** `ApplyError.partial` always carries the `ApplyResult` of operations that did succeed before the failure.

### Secrets

- **sops shell-out, not in-process.** `resolveRef("secrets/syncthing-api-keys.enc.yaml#mac-studio")` runs `sops -d --extract '["mac-studio"]' <path>` and captures stdout. Requires `SOPS_AGE_KEY_FILE` env.
- **In-memory cache per process.** First resolve hits sops; subsequent resolves of the same ref return the cached value. Cleared on process exit.
- **No secret in logs.** A `redact()` helper redacts known secret values from error messages and verbose-mode dumps.
- **Apply is the only place that decrypts.** `plan()` records refs in the `ApplyPlan`; `apply()` resolves them just before each adapter call. Plans can be safely written to disk or logged.

### Network failures and retries

- **Per-host independence.** A failure on one host does not abort apply for others. `ApplyResult` lists per-host status: `{ host, status: "applied" | "skipped" | "failed", ops, error? }`.
- **Retry on transient errors only.** Network errors and 5xx → 3 retries with 500ms / 1s / 2s backoff. 4xx → no retry, surface immediately.
- **Adapter timeouts.** Existing adapter clients take `timeoutMs` (10s default). The CLI exposes `--host-timeout-ms`.
- **No transaction across hosts.** Syncthing folder state is eventually consistent across the mesh. Partial apply is okay; verify catches anything that didn't take.

### Verify

After apply, re-read each host's `/rest/config/folders/<id>` and `/rest/db/ignores?folder=<id>`. Each successful op must round-trip. `VERIFY_FAILED` surfaces any field whose post-apply value doesn't match the plan.

### Schema validation

JSON schemas (folder, host, ruleset, schedule) are loaded via `ajv` and validated at load time. Errors include the YAML path and JSON pointer.

Cross-document constraints (paths references must point at existing hosts, ruleset must exist, `cloud.anchor` must reference a `role: cloud-edge` host) live in `apply-planner/load.ts` because JSON Schema can't express them. They produce `PlanError` with the specific code.

## Testing strategy

| Layer | What's tested | How |
|---|---|---|
| `apply-planner.plan` | manifest → ApplyPlan | **Golden files**. Fixtures: copies of real `synccenter-config/folders/test.yaml`, `example-code-projects.yaml` with all 3 host manifests. Expected output as JSON in `test/golden/*.json`. Update via `BUN_UPDATE_GOLDEN=1`. |
| `apply-planner.conflict` | each policy → engine flags | Unit, pure transform |
| `apply-planner.delta` | each drift category | Unit, hand-rolled live-state + plan inputs |
| `apply-planner.render-crontab` | SchedulePlan[] → text | Golden file |
| `apply-planner.apply` | end-to-end against mocked adapters | Mock `SyncthingClient` and `RcloneClient`. Verify op order, verify `ApplyError.partial` reports correctly when ops 1–2 succeed and op 3 fails |
| `state-importer.canonical` | round-trip property | `yaml.parse(canonicalEmit(yaml.parse(x))) deepEquals yaml.parse(x)` for every fixture |
| `state-importer.ruleset-match` | live ignores → ruleset name | Fixtures of live ignore lists from each known ruleset's `.stignore` |
| `state-importer.importFolder` | idempotency | Mocked adapter returns live state. First import → write. Second import → `identical` |
| Schema | every fixture validates | ajv against `synccenter-config/folders/*.yaml` and `hosts/*.yaml` |
| **e2e (gated)** | one apply against the live test folder | `SC_E2E=1` + `SOPS_AGE_KEY_FILE` required. Brings up the test folder from `folders/test.yaml`, verifies on all three hosts. CI does not run this; operator runs after wiring up |

**CI:** `bun typecheck` + `bun test` across all packages. No host access required.

**Test data hygiene:** fixtures are committed copies alongside test files. Real `synccenter-config/` is not mutated by tests.

## Operational gotchas

1. **First bisync needs `--resync`.** The apply-planner detects "this folder has never been bisynced" by checking for the absence of a bisync working-dir marker on the anchor host (an adapter helper queries rclone rcd). When detected, `apply()` errors with code `BISYNC_NEEDS_RESYNC` and instructs the operator to run `sc folders bisync init <name>` manually. We do not auto-resync — a bad auto-resync can wipe data.
2. **Device pairing precedence.** Before adding a folder that involves a device, that device must already be in `/rest/config/devices` on every host that's about to share with it. The planner orders ops as `addDevice* → addFolder → setIgnores → patchFolder`. Adding a device twice is a no-op in Syncthing.
3. **Ignores push is independent of folder shape.** `setIgnores` doesn't require the folder to be paused. The plan re-pushes ignores on every apply when the `.stignore` content has drifted from the compiled output — keeping live ignores authoritative-via-manifest.

## Exit criteria

Phase 2 is done when:

1. `bun typecheck` + `bun test` green across all packages, including new `apply-planner` and `state-importer`.
2. `sc state import folder test --write` rewrites `synccenter-config/folders/test.yaml` and a second run produces `status: "identical"` (idempotent).
3. `sc state import host mac-studio --write` and `sc state import host qnap-ts453d --write` produce idempotent YAML matching what's already committed.
4. `sc folders apply test --dry-run` produces zero deltas against the live mesh.
5. `sc folders apply example-code-projects --dry-run` produces the expected addFolder/setIgnores/SchedulePlan for all three hosts plus the QNAP bisync schedule entry.
6. `sc schedule render` produces a crontab fragment matching the expected bisync schedule.
7. Schema validates every file in `synccenter-config/folders/` and `synccenter-config/hosts/` without error (`hosts/win-desktop.yaml` no longer fails).
8. `hosts/qnap-ts453d.yaml` carries `role: cloud-edge` (committed to `synccenter-config`).
9. Optional e2e: `SC_E2E=1 bun test:e2e` runs an apply against the live `test` folder and verifies it round-trips. Operator-gated.

## Out of scope (defer to Phase 3+)

- Daemonized scheduling inside `apps/api` (rclone rcd `_async` job orchestration). The data shape is committed via `SchedulePlan[]`; the renderer differs.
- `apps/web` UI for plan / apply / import / conflict resolution.
- MCP tool surface for plan/apply/import (the API endpoints land first; MCP wraps them later).
- Prometheus metrics emission from apply (already planned for Phase 4).
- Versioning configuration (Syncthing `Versioning` struct) for non-`type: off` policies — the planner emits whatever the manifest declares; verification round-trips the value; complex staggered-policy validation is Phase 3.
- Encrypted folders (`type: receive-encrypted`). Manifest type stays in the enum; planner emits a `warnings[]` entry "encrypted folders not yet wired" and skips the device-key-distribution step.
