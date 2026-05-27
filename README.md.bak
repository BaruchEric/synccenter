# SyncCenter

Unified sync command center for Mac, QNAP, Windows, Google Drive, and mobile — powered by **Syncthing** (P2P mesh) and **rclone** (cloud + bisync). GitOps-driven, Claude-friendly.

- **Plan:** [`docs/SyncCenter-Project-Plan.md`](./docs/SyncCenter-Project-Plan.md)
- **State repo (sibling):** `../synccenter-config` — folder definitions, rules, host manifests, sealed secrets.
- **Agents:** [`.claude/agents/`](./.claude/agents/) — one Claude Code sub-agent per role.

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
observability/
  prometheus/    scrape config + 7 alert rules.
  grafana/       Provisioning-ready dashboard JSON (templated host/folder).
docker-compose.yml  QNAP deploy: synccenter-api + syncthing + rclone-rcd.
```

## Quick tour

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
5. `sc apply <folder> --dry-run` → preview the .stignore that will land on every Syncthing host.
6. `sc apply <folder>` → push to every host's `/rest/db/ignores` + trigger a rescan. Logged to `apply_history`.
7. `sc bisync trigger <folder>` → run an rclone bisync to the cloud edge.

## Status

| Phase | What | Status |
|---|---|---|
| 0 | Repo + agent scaffolding | done |
| 1 | Host install + pairing | manual (operator runs) |
| 2 | Rule compiler + gitignore importer + CLI | done |
| 3 | API, adapters, web UI, CLI remote mode | done |
| 4 | MCP server + Prometheus + alerts + Grafana | done |
| 5 | docker-compose + hardening | compose done; sops + key rotation pending |

## Tests

```sh
bun test                        # 117 across rule-compiler, importers, adapters, api, cli, mcp
bunx tsc -p apps/api --noEmit
bunx tsc -p apps/web --noEmit
```

## License

Private. Personal infrastructure tool.
