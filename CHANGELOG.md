# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions group commits by phase; see `git log` for individual commits.

## [Unreleased]

### Changed — BREAKING: cloud remotes are now mesh members
- Folder manifests no longer have a `cloud:` block. A cloud remote (Google Drive, Dropbox, S3, another NAS — anything rclone speaks) is now a **host** with `engine: rclone` and a `remote:` name (`hosts/gdrive.yaml`), and joins a folder like any other member: a key under `paths:` whose value is the path inside the remote. Bisync scheduling moved to a folder-level `bisync:` block (`anchor`, `schedule`, `flags`), with per-member overrides under `overrides.<member>.bisync`. Migration: `cloud.rclone_remote`+`remote_path` → a `hosts/<name>.yaml` with `engine: rclone` + a `paths.<name>` entry; `cloud.anchor`/`cloud.bisync.*` → the `bisync:` block.
- `host.schema.json` gained `engine: syncthing | rclone` (default syncthing). rclone hosts require only `name` + `remote`; syncthing hosts keep the previous required set.
- Planner: syncthing ops are built across syncthing members only; each rclone member gets its own scheduled bisync leg against the anchor (the unique `role: cloud-edge` host, or `bisync.anchor`). New plan errors: `NO_SYNCTHING_MEMBER`, `ANCHOR_NOT_SYNCTHING`, `ANCHOR_NOT_IN_PATHS`. `SchedulePlan` gained a `member` field.
- API: `POST /folders/:name/bisync` targets an rclone member (`?member=` when a folder has several); folder state/pause/resume skip rclone members. UI: the form's `cloud:` section became `bisync:`, rclone members are added as path rows (with remote-path completion via the same browse picker), and job pages badge each rclone member.

### Added
- HTMX console at `/ui` on the API (no build step, htmx served from node_modules): sign-in via the API token (HttpOnly cookie scoped to `/ui`), sync-job list, a create form with live YAML manifest preview + inline name validation + plan preview, and a job detail page with plan, dry-run-default apply (arm checkbox required for real applies, prune/force affordances on 409), per-host live state, and apply history.
- `POST /folders` JSON endpoint — validates against folder.schema.json + config-repo coherence (ruleset/hosts exist, name free) and writes canonical YAML via the state-importer emitter. 201/400/409 with coded errors.
- `validateFolderManifest()` export in `@synccenter/apply-planner` for in-memory schema validation.
- Form pickers: per-host path completion via each host's Syncthing `/rest/system/browse` (new `SyncthingClient.browse()`), rclone remote-name + remote-path completion via `config/listremotes` and a new `RcloneClient.listDirs()` (`operations/list`, dirsOnly), and a cron preset menu with a live plain-English readout of the bisync schedule. All degrade to silent-empty when the backing daemon is unreachable.
- Top-level README + this changelog.

### Changed
- `POST /folders/:name/apply` route refactored onto a shared `applyFolder` service (used by both the JSON API and the UI); dry runs now record `result: dry-run` in apply_history instead of `ok`.
- The HTMX console retires into the React dashboard wherever a bundle is configured. `/ui/jobs` and `/app/folders` had always listed the same folder manifests under two names, so with `SC_WEB_DIR` set `GET /` redirects to `/app/` and every `/ui/*` route forwards to its React equivalent (`/ui/jobs` → `/app/folders`, `/ui/jobs/new` → `/app/folders/new`, `/ui/jobs/:name` and its `plan`/`apply`/`state` children → `/app/folders/:name`, everything else → `/app/`). Both consoles authenticate against the same `SC_API_TOKEN`, so an open session costs one re-entry rather than a new credential. With no bundle configured the console stays mounted unchanged and `GET /` still redirects to `/ui/jobs` — it is the fallback UI for dev and the test suite. **Not carried across:** the console's host/remote path picker (`/ui/frag/browse-host`), which was an htmx HTML fragment with no JSON equivalent; the React folder editor still takes paths as text.
- docker-compose: syncthing and rclone-rcd now bind the whole `/share` at `/share` (host-path parity) instead of `/share/Sync` at `/Sync`, so folder-manifest paths anywhere under `/share` resolve inside both containers. Note: this gives both daemons read-write access to the entire share tree. Applied to the live QNAP deploy 2026-07-16.

## [phase-5]

### Added
- `docker-compose.yml` for the QNAP deploy: synccenter-api (oven/bun:1.1-alpine) + LinuxServer.io Syncthing + rclone-rcd, all on an internal Docker network with Traefik labels for `sync.beric.ca`.
- `observability/grafana/synccenter.json` — provisioning-ready dashboard with templated `host` and `folder` variables.

## [phase-4]

### Added
- Real Prometheus exporter at `/metrics`: per-host online + uptime + version, per-folder per-host state/bytes/need/errors, conflicts open, apply totals by result. Live host queries on every scrape in parallel.
- `observability/prometheus/{scrape,alerts}.yml` — drop-in scrape config and 7 alert rules (API down, host offline, conflicts >0 for 1h, folder errors, stuck-syncing, apply failures, scrape backend errors).
- `apps/mcp` — MCP server over stdio exposing 14 tools to Claude. Mutating tools require `confirm: true` (dry-run carve-out for `sc_apply`). `docs/mcp/claude-code.md` has the registration snippet.

## [phase-3]

### Added
- `apps/api` — Express + `bun:sqlite` REST API. Bearer-token auth, `/health` + `/metrics` public, everything else gated. Endpoints across `/folders`, `/rules`, `/hosts`, `/conflicts`, `/jobs`, `/apply-history`, `/imports`, `/rclone/*`.
- `packages/adapters/syncthing` — typed REST client for the Syncthing API: ping, version, status, folders config/status, ignores read/write, scan, addFolder, pause/resume, events long-poll. AbortController timeouts; SyncthingError with status + endpoint.
- `packages/adapters/rclone` — typed client for rclone rcd: version, stats, listRemotes, about, jobs, bisync. Basic + Bearer auth.
- `HostRegistry` resolves Syncthing API keys from `SC_HOST_API_KEY_<HOST>` env vars (sops integration deferred to phase-5). Routes wired through registry for apply / pause / resume / state.
- `POST /folders/:name/apply` compiles the ruleset, pushes `.stignore` to every host's `/rest/db/ignores`, triggers a scan, logs to `apply_history`. Returns 207 on partial failure with per-host detail.
- `POST /folders/:name/bisync` runs rclone bisync between the cloud-edge host's local path and the configured remote, using the compiled `filter.rclone`. Records to `apply_history`.
- `apps/web` — Vite + React 18 + Tailwind + TanStack Query. Bearer-token sign-in. Routes: dashboard, folders, folder detail (dry-run preview + apply/pause/resume), rules, hosts, conflicts.
- `sc` CLI gains remote-mode commands (`status`, `apply`, `pause`, `resume`, `bisync trigger`, `host-status`, `folder-state`, `conflicts list`) using `--api`/`SC_API_URL` and `--token`/`SC_TOKEN`.

## [phase-2]

### Added
- `packages/rule-compiler` — pure transform from ruleset YAML to `.stignore` + `filter.rclone`. Imports resolved on disk only; engine-divergence detection refuses to emit unless `--allow-divergent`. 9 golden tests cover order semantics, includes-to-rclone translation, and engine_overrides.
- `packages/importers` — fetches `github://github/gitignore/<NAME>` (nested paths supported) and `url://https://...` (allowlist-gated), caches under `synccenter-config/imports/`, maintains `checksums.json` with SHA-256 and fetched-at. 7-day default freshness. Serial writes to avoid the parallel-fetch race.
- `apps/cli` — `sc` CLI: `rules list|compile|preview|show`, `folders list|get`, `imports list|refresh` — all local operations against `synccenter-config/`.
- `packages/schema` — JSON Schemas for ruleset, folder, host, schedule. Drive Monaco autocomplete in the web UI and runtime validation in the rule-compiler.

## [phase-1-prep]

### Added
- JSON Schemas + example fixtures (ruleset, folder, hosts) in `synccenter-config`.

## [phase-0]

### Added
- Both repos scaffolded: `synccenter` (tool) and `synccenter-config` (state).
- 11 Claude Code sub-agent definitions in `.claude/agents/` covering scaffolding, deploy, compile, fetch, build, validate, document.
- Project plan committed at `docs/SyncCenter-Project-Plan.md`.
