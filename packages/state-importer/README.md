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
