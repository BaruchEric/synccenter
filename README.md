# SyncCenter

Unified sync command center for Mac, QNAP, Windows, Google Drive, and mobile — powered by **Syncthing** (P2P mesh) and **rclone** (cloud + bisync). Built with Claude Code sub-agents.

- **Plan:** [`docs/SyncCenter-Project-Plan.md`](./docs/SyncCenter-Project-Plan.md)
- **State repo (sibling):** `../synccenter-config` — folder definitions, rules, host manifests, sealed secrets.
- **Agents:** [`.claude/agents/`](./.claude/agents/) — one sub-agent per role (rule compiler, infra deployer, API builder, etc.).

## Repo layout

```
apps/
  api/    Node + Express + SQLite (the command-center API)
  web/    React + Vite + Tailwind (dashboard, editors, conflict resolver)
  cli/    `sc` binary
  mcp/    MCP server exposing tools to Claude
packages/
  rule-compiler/  YAML → .stignore + rclone filter
  importers/      gitignore / github / file / url
  adapters/       Syncthing REST + rclone rcd clients
  schema/         JSON Schemas for all YAML files
observability/
  prometheus/     scrape config + alert rules
  grafana/        dashboards as JSON
tests/
  golden/         rule-compiler golden files
  e2e/            sync propagation tests
docker-compose.yml  QNAP deploy
```

## Status

**Phase 0 — Foundation:** scaffolding complete. Next phases drive deployment, the rule engine, and the command center. See the plan for details.

## Working with the agents

Drive each phase by prompting the planner:

```
Execute Phase 1 from the plan. Use the appropriate agents.
```

The planner routes work to sub-agents declared in `.claude/agents/`. Each agent commits to a feature branch; the planner merges after the `validator` agent passes.

## Tooling

Bun workspaces (apps + packages). TypeScript strict. Lint/typecheck/build/test must pass before any apply.

```sh
bun install
bun run lint
bun run typecheck
bun run test
bun run build
```

## License

Private. Personal infrastructure tool.
