# observability/grafana

Grafana dashboard JSON for SyncCenter, provisioned into `grafana.beric.ca`.

Owned by [`dashboard-builder`](../../.claude/agents/dashboard-builder.md). Populated in Phase 4.

Panels: devices online, folders by state, conflicts open over time, last bisync duration, throughput per device.

Use Grafana variables for `instance` and `folder` — no hardcoded host names.
