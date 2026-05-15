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
