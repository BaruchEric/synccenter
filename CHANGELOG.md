# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions group commits by phase; see `git log` for individual commits.

## [Unreleased]

### Added — jobs: every leg of a press under one id, with the sum (2026-08-25)
- **Jobs.** A press of Sync now used to leave two unrelated rows (a sync window, then a bisync run) that nothing tied together. Every unit of work the API drives is now a **job**: the Sync now chain (`kind: sync` — windows, then the cloud bisync), a window on its own (`window` — a schedule firing, or `?cloud=false`), or a bisync on its own (`bisync` — Cloud only, or `POST /folders/:name/bisync?async=true`). Runs and windows carry a `job_id`; the job settles from its legs (`done` / `partial` / `failed` / `stopped`) once nothing is running and the cloud leg is no longer pending, and it records legs that never got a row (a window that could not open, a bisync that did not start) with the reason. A second Sync now while the first chain is still waiting rides the first job instead of minting an empty one. Boot closes out jobs left waiting by the previous process. New `jobs` table plus `job_id` columns on `runs` and `sync_windows` (added in place on an existing database).
- API: `GET /jobs?limit&before&folder&kind&state` (each job with its legs and `totals`: bytes, transfers, checks, listed, errors, files still needed, wall-clock and per-leg seconds, cap seconds, legs done/running/failed), `GET /jobs/:id`, `POST /jobs/:id/stop` (closes open windows, cancels running bisyncs, drops a queued cloud leg). `POST /folders/:name/sync` returns the `job`. `/events` pushes a `job` frame when a job settles. `GET /log` takes `since` and `until`.
- UI: **History → Jobs**, a table with kind/result filters, the legs each job ran, what it moved, how long it took, and a ruled sum of the loaded rows. Each job links to **`/app/history/jobs/:id`**: the route drawn station to station (Mac mesh → NAS window → Drive bisync) with each segment a live meter, a timetable of the legs (opened, closed, took, moved / in sync, files, checked, errors, result) under a double-ruled sum, the derived figures (throughput, cap use, what was left behind, peers caught up), and the folder's log lines for that stretch. Sync now's status note, the folder list's live lines and the runs/windows tables all link to the job. CLI: `sc jobs [--folder] [--limit]`.

### Fixed — Sync now reaches the cloud leg (2026-08-25)
- **Sync now** on a folder like `baruchrio` opened the Syncthing window on the NAS and stopped there: Drive only ever heard from the nightly crontab. `POST /folders/:name/sync` now runs every leg in order — windows on the held members, then, once those windows close, an rclone bisync to every rclone member (straight away when nothing is held). Closing a window by hand cancels the queued cloud leg; a timeout does not. `?cloud=false` keeps the old windows-only behaviour. A cloud leg that cannot start (missing filter, rcd down) is written to the ledger as an error instead of vanishing. New `SyncNow` chain in `apps/api/src/lib/sync-now.ts`; the bisync trigger moved into `lib/bisync-service.ts` so the chain and the route share it.
- `GET /schedule` planned its bisync jobs through the secrets resolver, which the deployed container cannot run (no `sops`), so it answered with no jobs at all and the dashboard showed every folder as "local mesh only" with no bisync button. The schedule is now planned from the manifests alone (`planScheduleJobs`), and a folder that cannot be planned is named in `jobsError` without blanking the others. `/schedule/crontab` renders from the same plan. The web UI also stopped inferring cloud membership from the schedule: it reads each host's `engine` instead.
- UI: "Sync now" appears for any folder with a held member or a cloud member; "Cloud only" (bisync without a window) stays as a secondary action. The folder list shows open windows and the next window/bisync times, taking the bisync cron from the manifest when the schedule endpoint has none. CLI: `sc sync <folder> [--no-cloud]`. MCP: `sc_sync_folder`.

### Added — History and Logs pages (2026-08-25)
- **History** (`/app/history`): the whole ledger with folder / kind (apply, bisync, sync window) / result filters and cursor paging, plus tables of bisync runs (bytes, transfers, checks, duration) and sync windows (in sync, still needed, peers, duration, why it closed). API: `GET /apply-history?limit&before&folder&result&kind` (rows now carry `kind`, responses carry `nextBefore`); `GET /runs` and `GET /windows` take `?folder=&before=` and return `nextBefore`.
- **Logs** (`/app/logs`): SyncCenter's own operational log — windows opened and why they closed, bisync starts and finishes, applies, the reconciler re-pausing a member, Sync-now chain steps, folder mutations — stored in a new `log_lines` table (capped at 20 000 rows), mirrored to stdout, pushed over `/events` as `log` frames, and read via `GET /log?limit&before&folder&level&source&q`. Below it, Syncthing's own log per host (`GET /hosts/:name/log`, new adapter `getSystemLog()`) and the per-file errors behind a folder's `errors` count (`GET /folders/:name/errors`, new adapter `getFolderErrors()`).

### Fixed — apply no longer wipes a folder's versioning (2026-08-22)
- `POST /rest/config/folders` replaces an existing folder wholesale, and the planner parsed `versioning:` but never put it on the wire, so every re-apply reset the live folder to no versioning. `arik`, `dev` and `memory-vault` were all found at versioning NONE on 2026-08-22 despite declaring staggered 30d; only `baruchrio` (never re-applied since being armed by hand) still had it. Two changes: the planner now maps the manifest block onto Syncthing's wire shape (`packages/apply-planner/src/versioning.ts`: `maxAge: 30d` → `"2592000"`, Syncthing's own defaults for omitted params, `type: off` → `""`), and `apply` PATCHes a folder that already exists instead of re-POSTing it, so fields the planner does not manage survive too. `versioning` joined the delta/verify field set, so a live folder that lost it now reads as DIVERGENT (`--force` to re-arm from the manifest). New plan error `VERSIONING_INVALID`.

### Added — sync windows: scheduled/manual members instead of realtime
- Per-member sync modes (`sync.mode: realtime | scheduled | manual`, folder-level or `overrides.<member>.sync`) for Syncthing members that should not sync continuously — built for the QNAP, whose CPU was pinned by watcher + delete-retry churn. A held member keeps its folder **paused** except during **sync windows**: resumed on a cron (`sync.schedule`) or on demand, polled until caught up locally and at every connected peer, then paused again (`max_window_minutes` cap, default 60). Runs inside the API (`SyncWindowEngine`) — cron sweep, 2 s window polling with live SSE `window` events, and a reconciler (boot / 5 min / after apply) that re-pauses any held member left running.
- Planner: a held member's applied config forces `fsWatcherEnabled: false` and `rescanIntervalS: 86400` (warning when the manifest asked for the watcher); `rescanIntervalS` joined the delta/verify field set. New adapter calls: `getConnections()`, `getCompletion(folder, device)`.
- API: `POST /folders/:name/sync[?host=]`, `GET /windows`, `GET /windows/:id`, `POST /windows/:id/stop`; `/schedule` gained a `windows` list; `/folders/:name/state` reports each member's `mode`; `/events` hello carries recent windows. New `sync_windows` table, abandoned-on-boot like runs.
- UI: **Sync now** action on folders with held members, a live `WindowBand` on the activity timeline (phase, % in sync, peers caught up, close control), scheduled windows on the upcoming timeline, and held members reading `held · scheduled` instead of `paused`. CLI: `sc sync <folder> [--host]`, `sc windows`.
- Runbook: `docs/runbooks/scheduled-sync.md` (includes deploy order: API code before manifests that use `sync:`).

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
- Hosts page links each Syncthing host to its web GUI — the daemon serves the GUI and the REST API off one listener, so the manifest's `syncthing.api_url` is already the address. Labelled with the host:port rather than a generic "open GUI": `api_url` is recorded from the API's vantage point, so `qnap-ts453d` carries a LAN address while `mac-studio` carries `127.0.0.1`, which only reaches that daemon from that machine.
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
