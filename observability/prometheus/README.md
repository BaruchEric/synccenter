# observability/prometheus

Scrape config + alert rules for SyncCenter's `/metrics` endpoint.

Owned by [`dashboard-builder`](../../.claude/agents/dashboard-builder.md).

## Files

- `scrape.yml` — a fragment, not a whole config: drops into the existing
  Prometheus stack's `scrape_configs`. Targets `sync.beric.ca` over https with
  no credentials, because `/metrics` is mounted public in `apps/api/src/app.ts`
  alongside `/health`. 30s interval, 15s timeout — the handler queries every
  Syncthing host per scrape.
- `alerts.yml` — 8 rules: `SyncCenterAPIDown`, `SyncCenterHostOffline`,
  `SyncCenterFolderHasConflicts`, `SyncCenterFolderErrors`,
  `SyncCenterFolderOutOfSyncLong`, `SyncCenterApplyFailures`,
  `SyncCenterIgnoreFileRejected`, `SyncCenterScrapeBackendErrors`.
- `alerts_test.yml` — `promtool` unit tests for `SyncCenterIgnoreFileRejected`.

## Validate before commit

`promtool` ships with the Prometheus server — `brew install prometheus` (there
is no standalone formula; installing does not start a service).

```bash
promtool check rules  observability/prometheus/alerts.yml
promtool check config observability/prometheus/scrape.yml
promtool test  rules  observability/prometheus/alerts_test.yml
```

`check rules` only proves the PromQL parses. `SyncCenterIgnoreFileRejected` is
almost entirely a vector join, and a join that matches nothing is
indistinguishable from a healthy fleet — that alert is the only thing that
notices a rejected ignore file. Hence the unit tests: they pin that it fires
per-member for a live host, and that the `and on(folder, host)` guard drops a
folder which is in the manifest but not yet applied (Syncthing answers
`db/ignores` with HTTP 200 and `error="folder X does not exist"` for those, so
`ignores_error` is 1 on benign config).

Each assertion has been mutation-checked: removing the join, weakening `> 0` to
`> 1`, and stretching `for: 2m` each make the suite fail.
