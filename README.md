# synccenter

A unified control plane over a Syncthing mesh and rclone cloud sync, driven by versioned YAML and operable through a CLI, REST API, React dashboard, or Claude over MCP.

## TL;DR

- **What:** One command center that separates *policy* (what to sync/ignore, where) from *mechanism* (Syncthing + rclone). You author folder/ruleset/host/schedule YAML; SyncCenter compiles engine-specific ignore artifacts and pushes them to every host.
- **How:** Rulesets compile to `.stignore` (Syncthing) and `filter.rclone` (rclone). Applying a folder pushes ignores to each host's `/rest/db/ignores`, triggers a rescan, and logs the result to a SQLite `apply_history` table.
- **GitOps:** All state lives in the sibling repo `../synccenter-config`. Every UI/CLI edit commits back; rollback is `git revert` + re-apply.
- **Stack:** Bun monorepo (workspaces) in TypeScript — Express + `bun:sqlite` API, React + Vite + Tailwind + TanStack Query dashboard, an MCP server, AJV/JSON-Schema-validated config, and Prometheus + Grafana observability.
- **Run:** `bun install`, then compile a ruleset locally with the `sc` CLI, or bring up the API and point the dashboard/CLI at it.
- **Deploy:** `docker-compose.yml` runs the API + Syncthing + rclone-rcd on a QNAP behind Traefik at `sync.beric.ca`.

## Overview

SyncCenter is the single control plane over two sync mechanisms — a Syncthing P2P mesh and rclone cloud/bisync — for a Mac / QNAP / Windows / Google Drive topology.

Policy is authored as YAML in the sibling repo `../synccenter-config` (folders, rulesets, host manifests, schedules, SOPS-sealed secrets) and is the single source of truth. SyncCenter reads that repo, compiles each ruleset into engine-specific artifacts (`.stignore` for Syncthing, `filter.rclone` for rclone), and applies them to live hosts — recording every apply in a SQLite history table. UI and CLI edits commit back to the config repo, keeping the repo and live state in lockstep.

## Repository layout

```
apps/
  api/    Express + bun:sqlite — REST API + /metrics. Owns the apply lifecycle.
  cli/    `sc` binary. Local rule compilation / import refresh + remote-mode for everything else.
  mcp/    @modelcontextprotocol/sdk server. Exposes the API to Claude over stdio.
  web/    React + Vite + Tailwind + TanStack Query. Dashboard, folder detail, dry-run, apply.
packages/
  adapters/       Typed Syncthing + rclone REST clients (no business logic).
  importers/      github://gitignore + url:// fetcher, allowlisted, sha256-pinned, weekly refresh.
  rule-compiler/  YAML rulesets → .stignore + filter.rclone. Engine-divergence detection.
  schema/         JSON Schemas for ruleset / folder / host / schedule.
  apply-planner/  Plans the diff between desired and live host state (+ schedules, secrets, verify).
  state-importer/ Ingests existing host/folder state into config YAML.
observability/
  prometheus/     Scrape config + alert rules.
  grafana/        Provisioning-ready dashboard JSON (templated host/folder).
scripts/          QNAP bootstrap, rclone.conf rendering, host-secret seeding.
docs/             Project plan + runbooks + MCP registration.
docker-compose.yml  QNAP deploy: synccenter-api + syncthing + rclone-rcd.
```

- **Plan:** [`docs/SyncCenter-Project-Plan.md`](./docs/SyncCenter-Project-Plan.md)
- **State repo (sibling):** `../synccenter-config` — folder definitions, rules, host manifests, schedules, sealed secrets.
- **Agents:** [`.claude/agents/`](./.claude/agents/) — one Claude Code sub-agent per role.

## Tech stack

- **Runtime / package manager:** Bun (`>=1.1.0`) with workspaces (`apps/*`, `packages/*`).
- **Language:** TypeScript (`^5.5`), shared `tsconfig.base.json`.
- **API:** Express + `bun:sqlite`, bearer-token auth, `/metrics` Prometheus exporter.
- **Web:** React 18, Vite, Tailwind, TanStack Query, React Router.
- **CLI:** `commander`, dual local/remote mode.
- **MCP:** `@modelcontextprotocol/sdk` over stdio.
- **Config validation:** `ajv` (JSON Schema), `yaml`.
- **Observability:** Prometheus scrape + alert rules, Grafana dashboard JSON.
- **Deploy:** Docker Compose (`oven/bun`, LinuxServer.io Syncthing, official rclone) behind Traefik.

## Getting started

```sh
bun install

# Compile a ruleset locally (no API needed)
bun run apps/cli/src/index.ts --config ../synccenter-config rules compile dev-monorepo

# Refresh the github/gitignore cache (allowlisted; weekly default)
bun run apps/cli/src/index.ts --config ../synccenter-config imports refresh

# Bring up the API
SC_CONFIG_DIR=$(pwd)/../synccenter-config \
SC_API_TOKEN=$(openssl rand -hex 32) \
bun run apps/api/src/index.ts       # listens on :3000

# In another shell: dashboard
cd apps/web && bun run dev          # http://localhost:5173 → paste the token

# Or drive the CLI in remote mode
SC_API_URL=http://localhost:3000 SC_TOKEN=$SC_API_TOKEN \
bun run apps/cli/src/index.ts status
```

### End-to-end apply flow

1. Author the ruleset in `synccenter-config/rules/<name>.yaml`.
2. `sc imports refresh` if it pulls from `github://`.
3. `sc rules compile <name>` (or `POST /rules/:name/compile`) to preview the compiled ignores.
4. Reference the ruleset from a folder in `synccenter-config/folders/<name>.yaml`.
5. `sc apply <folder> --dry-run` → preview the `.stignore` that will land on every Syncthing host.
6. `sc apply <folder>` → push to every host's `/rest/db/ignores` + trigger a rescan. Logged to `apply_history`.
7. `sc bisync trigger <folder>` → run an rclone bisync to the cloud edge.

### Environment variables

| Var | Used by | Required | Default | Purpose |
|---|---|---|---|---|
| `SC_CONFIG_DIR` | api, cli (local) | yes | — | Path to the `synccenter-config` state repo. |
| `SC_API_TOKEN` | api | yes | — | Bearer token gating the API (min 16 chars). |
| `PORT` | api | no | `3000` | API listen port (0 = OS-assigned, for tests). |
| `SC_DB_PATH` | api | no | `:memory:` | SQLite file for apply history / state. |
| `SC_RCLONE_URL` | api | no | — | rclone rcd base URL; presence enables rclone. |
| `SC_RCLONE_USER` / `SC_RCLONE_PASS` | api | no | — | rclone rcd basic auth. |
| `SC_RCLONE_BEARER` | api | no | — | rclone rcd bearer auth (alternative to basic). |
| `SC_HOST_API_KEY_<HOST>` | api | per host | — | Syncthing API key per host (e.g. `SC_HOST_API_KEY_QNAP_TS453D`). |
| `SC_API_URL` / `SC_TOKEN` | cli (remote) | for remote mode | — | Target API URL + bearer token for remote CLI commands. |
| `SC_MCP_TOKEN` | mcp | for MCP | — | Bearer token the MCP server uses to reach the API. |

## Scripts

Root scripts (run via `bun run <name>` from the repo root):

| Script | Command | Notes |
|---|---|---|
| `typecheck` | `bun run --filter '*' typecheck` | `tsc --noEmit` across every workspace. |
| `test` | `bun test` | 22 test files (rule-compiler, importers, adapters, apply-planner, state-importer, api, cli, mcp). |
| `build` | `bun run --filter '*' build` | Bundles/compiles each workspace; some packages are still `echo` placeholders. |
| `lint` | `echo 'lint: configure in phase 3'` | **Placeholder — not yet wired.** |

Notable per-workspace scripts: `apps/api` `dev`/`start`, `apps/web` `dev`/`build`/`preview`, `apps/cli` `build` (compiles the `sc` binary), `apps/mcp` `build` (compiles `synccenter-mcp`).

## Architecture

SyncCenter is a policy → mechanism compiler with a live-apply lifecycle:

- **`packages/rule-compiler`** — pure transform from ruleset YAML to `.stignore` + `filter.rclone`. Imports are resolved on disk; engine-divergence detection refuses to emit unless `--allow-divergent`.
- **`packages/importers`** — fetches `github://github/gitignore/<NAME>` and allowlist-gated `url://` sources, caches under `synccenter-config/imports/`, and pins each with a SHA-256 checksum (7-day freshness). Serial writes avoid a parallel-fetch race.
- **`packages/adapters`** — typed REST clients for the Syncthing API (ping/version/status/ignores/scan/pause/resume/events) and rclone rcd (version/stats/remotes/about/jobs/bisync), with AbortController timeouts. No business logic.
- **`packages/apply-planner`** — plans the diff between desired config and live host state; also covers schedules, secrets, and verify.
- **`packages/state-importer`** — ingests existing host/folder state back into canonical config YAML.
- **`packages/schema`** — JSON Schemas drive Monaco autocomplete in the web UI and runtime validation in the compiler.
- **`apps/api`** — Express + `bun:sqlite`. Bearer-token auth; `/health` + `/metrics` public, everything else gated. `POST /folders/:name/apply` compiles the ruleset, pushes ignores to every host, triggers a scan, and logs to `apply_history` (207 on partial failure with per-host detail). A `HostRegistry` resolves Syncthing API keys from `SC_HOST_API_KEY_<HOST>`.
- **`apps/web`** — React + Vite dashboard: bearer sign-in, then dashboard, folders, folder detail (dry-run preview + apply/pause/resume), rules, hosts, conflicts.
- **`apps/cli`** — the `sc` binary: local compile/import operations plus remote-mode commands against the API.
- **`apps/mcp`** — MCP server exposing the API to Claude over stdio; mutating tools require `confirm: true` (with a dry-run carve-out for `sc_apply`).

## Deployment

`docker-compose.yml` brings up three services on internal + edge Docker networks for the QNAP:

- **`synccenter-api`** (`oven/bun:1.1-alpine`) — the API, behind Traefik at `sync.beric.ca` (the only externally exposed service). Mounts the code read-only, the `synccenter-config` clone read-write, and a state volume for SQLite.
- **`syncthing`** (LinuxServer.io) — the mesh node; GUI on `8384` (internal, for bootstrap), transport on `22000`, discovery on `21027`.
- **`rclone-rcd`** (official rclone) — the rclone remote-control daemon on `5572`, internal only.

Bring it up with `docker compose --env-file .env up -d`. Secrets are injected at deploy time from a SOPS-sealed env file (`sops -d secrets/api-env.enc.yaml > .env`, never committed) — this supplies `SC_API_TOKEN`, rclone credentials, and the per-host Syncthing API keys.

## Status

Phases 0–4 are complete (repo scaffolding, rule compiler + gitignore importer + CLI, API + adapters + web UI + CLI remote mode, MCP server + Prometheus + alerts + Grafana). Phase 5 is partial: `docker-compose.yml` is done, but hardening — SOPS key rotation and the multi-recipient `age` setup — is still pending, so the QNAP currently relies on env-injected secrets at deploy time rather than in-container decryption.

**WIP / not-done flags:**
- `lint` is a placeholder (`echo 'lint: configure in phase 3'`) — no linter is wired yet.
- Several `packages/*` `build` scripts are `echo` placeholders ("bundle in phase 3"); only `apps/*` produce real build artifacts.
- Host install + pairing (phase 1) is a manual operator step, not automated by this tool.

## License

Private. Personal infrastructure tool.
