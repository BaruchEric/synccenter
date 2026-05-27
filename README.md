# SyncCenter

Unified sync command center over Syncthing (P2P mesh) + rclone (cloud + bisync) for Mac/QNAP/Windows/Google Drive, driven by versioned YAML and operable via CLI, REST API, web dashboard, or Claude over MCP.

## TL;DR

- **What:** One control plane over a Syncthing mesh and rclone cloud sync. You author folder/ruleset/host/schedule YAML; SyncCenter compiles ignore patterns and pushes them to every host.
- **GitOps:** All state lives in the sibling repo `../synccenter-config` (folders, rules, hosts, schedules, SOPS-sealed secrets). Every change is a commit; rollback is `git revert` + re-apply.
- **Surfaces:** `sc` CLI (local + remote mode), Express REST API, React/Vite dashboard, and an MCP server that exposes the API to Claude over stdio.
- **Stack:** Bun monorepo (workspaces), TypeScript, Express + `bun:sqlite`, React + Vite + Tailwind + TanStack Query, Prometheus + Grafana, AJV/JSON-Schema-validated config.
- **Deploy:** `docker-compose.yml` runs `synccenter-api` + Syncthing + rclone-rcd on a QNAP behind Traefik (`sync.beric.ca`).

## Overview

SyncCenter separates **policy** (what to sync, what to ignore, where) from **mechanism** (Syncthing + rclone). Policy is authored as YAML in `../synccenter-config` and is the single source of truth. SyncCenter reads that repo, compiles each ruleset into engine-specific artifacts (`.stignore` for Syncthing, `filter.rclone` for rclone), and applies them to live hosts — recording every apply in a SQLite history table. UI/CLI edits commit back to the config repo, keeping the repo and live state in lockstep.

## What's here

```
apps/
  api/    Express + bun:sqlite — REST API + /metrics. Owns the apply lifecycle.
  cli/    `sc` binary. Local rule compilation / import refresh + remote-mode for everything else.
  mcp/    @modelcontextprotocol/sdk server. Exposes the API to Claude over stdio.
  web/    React + Vite + Tailwind + TanStack Query. Dashboard, folder detail, dry-run, apply.
packages/
  adapters/      Typed Syncthing + rclone REST clients (no business logic).
  importers/     github://gitignore + url:// fetcher, allowlisted, sha256-pinned, weekly refresh.
  rule-compiler/ YAML rulesets → .stignore + filter.rclone. Engine-divergence detection.
  schema/        JSON Schemas for ruleset/folder/host/schedule.
  apply-planner/ Plans the diff between desired and live host state.
  state-importer/ Ingests existing host/folder state into config YAML.
observability/
  prometheus/    scrape config + alert rules.
  grafana/       Provisioning-ready dashboard JSON (templated host/folder).
scripts/         QNAP bootstrap, rclone.conf rendering, host-secret seeding.
docs/            Project plan + runbooks.
docker-compose.yml  QNAP deploy: synccenter-api + syncthing + rclone-rcd.
```

- **Plan:** [`docs/SyncCenter-Project-Plan.md`](./docs/SyncCenter-Project-Plan.md)
- **State repo (sibling):** `../synccenter-config` — folder definitions, rules, host manifests, schedules, sealed secrets.
- **Agents:** [`.claude/agents/`](./.claude/agents/) — one Claude Code sub-agent per role.

## Quick start

```sh
bun install

# Compile a ruleset locally (no API needed)
bun run apps/cli/src/index.ts --config ../synccenter-config rules compile dev-monorepo

# Refresh the github/gitignore cache (allowlisted; weekly default)
bun run apps/cli/src/index.ts --config ../synccenter-config imports refresh

# Bring up the API
SC_CONFIG_DIR=$(pwd)/../synccenter-config \
SC_API_TOKEN=$(openssl rand -hex 32) \
bun run apps/api/src/index.ts

# In another shell: dashboard
cd apps/web && bun run dev   # http://localhost:5173 → paste the token

# Or use the CLI in remote mode
SC_API_URL=http://localhost:3000 SC_TOKEN=$SC_API_TOKEN \
bun run apps/cli/src/index.ts status
```

## End-to-end apply flow

1. Author the ruleset in `synccenter-config/rules/<name>.yaml`.
2. `sc imports refresh` if it pulls from `github://`.
3. `sc rules compile <name>` (or `POST /rules/:name/compile`) to preview.
4. Reference the ruleset from a folder in `synccenter-config/folders/<name>.yaml`.
5. `sc apply <folder> --dry-run` → preview the `.stignore` that will land on every Syncthing host.
6. `sc apply <folder>` → push to every host's `/rest/db/ignores` + trigger a rescan. Logged to `apply_history`.
7. `sc bisync trigger <folder>` → run an rclone bisync to the cloud edge.

## Deploy (QNAP)

`docker-compose.yml` brings up three services on internal + edge networks:

- **`synccenter-api`** (`oven/bun`) — the API, behind Traefik at `sync.beric.ca` (the only externally exposed service). Mounts the code (read-only), the `synccenter-config` clone (read-write), and a state volume for SQLite.
- **`syncthing`** (LinuxServer.io) — the mesh node; GUI on `8384` (internal, for bootstrap), transport on `22000`, discovery on `21027`.
- **`rclone-rcd`** (official rclone) — rclone remote-control daemon on `5572`, internal only.

Secrets are injected at deploy time via `--env-file .env`, produced by decrypting a SOPS-sealed env file (`sops -d secrets/...` → `.env`, never committed). Per-host Syncthing API keys and rclone rcd credentials come from those env vars.

## Tests

```sh
bun test                        # 117 across rule-compiler, importers, adapters, api, cli, mcp
bunx tsc -p apps/api --noEmit
bunx tsc -p apps/web --noEmit
```

## Status

| Phase | What | Status |
|---|---|---|
| 0 | Repo + agent scaffolding | done |
| 1 | Host install + pairing | manual (operator runs) |
| 2 | Rule compiler + gitignore importer + CLI | done |
| 3 | API, adapters, web UI, CLI remote mode | done |
| 4 | MCP server + Prometheus + alerts + Grafana | done |
| 5 | docker-compose + hardening | compose done; SOPS + key rotation pending |

**WIP notes:** lint is not yet wired (`bun run lint` is a placeholder — "configure in phase 3"). Phase 5 hardening — SOPS key rotation and the multi-recipient `age` setup — is still pending; the QNAP currently relies on env-injected secrets at deploy time rather than in-container decryption.

## License

Private. Personal infrastructure tool.
