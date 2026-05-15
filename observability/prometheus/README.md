# observability/prometheus

Scrape config + alert rules for SyncCenter's `/metrics` endpoint.

Owned by [`dashboard-builder`](../../.claude/agents/dashboard-builder.md). Populated in Phase 4.

Files (target):

- `scrape.yml` — drops into the existing Prometheus stack's scrape configs.
- `alerts.yml` — `SyncCenterDeviceDown`, `SyncCenterFolderConflicting`, `SyncCenterBisyncFailed`, `SyncCenterInotifyFallback`.

Validate with `promtool check rules observability/prometheus/alerts.yml` before commit.
