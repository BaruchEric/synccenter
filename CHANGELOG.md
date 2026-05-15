# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions group commits by phase; see `git log` for individual commits.

## [Unreleased]

### Added
- Top-level README + this changelog.

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
