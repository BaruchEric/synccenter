# apps/api

Node + Express + SQLite — the SyncCenter REST API and Prometheus exporter.

Owned by [`api-builder`](../../.claude/agents/api-builder.md). Populated in Phase 3.

Expected shape:

```
apps/api/
  src/
    routes/          /folders /rules /hosts /jobs /conflicts /apply /metrics
    adapters/        re-exports from packages/adapters
    store/           SQLite + migrations
    auth/            bearer + session cookie
  openapi.yaml       contract consumed by web/cli/mcp
  migrations/        SQL files
  test/              unit + integration
  package.json
  tsconfig.json
```
