# packages/schema

JSON Schemas — the single source of truth for every YAML in `synccenter-config/`.

Owned by [`repo-init`](../../.claude/agents/repo-init.md) (initial draft) and updated by each builder agent as the data model evolves.

Files (Phase 0–2):

- `folder.schema.json`
- `ruleset.schema.json`
- `host.schema.json`
- `schedule.schema.json`

## Member model

Every participant in a folder is a **host** (a mesh member). `engine:` picks what powers it:

- `engine: syncthing` (default) — a live P2P device; requires `hostname`, `os`, `role`, `syncthing`.
- `engine: rclone` — an rclone-backed remote (Google Drive, Dropbox, S3, another NAS, …); requires only `remote`, the rclone remote name from the anchor host's `rclone.conf`.

A folder lists all members under `paths:` — local absolute paths for syncthing members, in-remote paths for rclone members. rclone members sync via scheduled `rclone bisync` legs against the **anchor** (the unique `role: cloud-edge` host, or `bisync.anchor`), configured by the folder's `bisync:` block and per-member `overrides.<member>.bisync`.

Consumed by:

- The `rule-compiler` (validates rulesets before compiling)
- The API (validates payloads on POST/PATCH)
- The web UI Monaco editors (autocomplete + inline errors)
- The CLI (`sc folders apply` validates locally before calling the API)
