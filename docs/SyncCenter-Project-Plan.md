# SyncCenter — Project Plan

> Unified sync command center for Mac + QNAP + Windows + Google Drive + Mobile
> **Engines:** Syncthing (P2P mesh) · rclone (cloud + bisync + LAN copy)
> **Built with:** Claude Code sub-agents
> **Owner:** Eric · **Target host:** QNAP TS-453D (`sync.beric.ca` via Traefik)

---

## 0. Scope & Goals

**v1 delivers:**

1. **Unified sync layer** — Syncthing as the live mesh across Mac/QNAP/Windows (+ mobile best-effort); rclone for Google Drive and any cloud edge.
2. **Smart rule engine** — one YAML format that compiles to `.stignore` (Syncthing) and `--filter-from` (rclone). Imports `.gitignore` files and the `github/gitignore` repo.
3. **Command center** — web UI + REST API + MCP server on the QNAP showing every sync job across every host. Start/stop/repair pairs from one screen.
4. **GitOps for sync configs** — every folder, rule, and schedule in a Git repo. Changes deploy via Claude Code agents.
5. **Observability hook** — Prometheus exporter that plugs into your existing Grafana stack on `grafana.beric.ca`.

**Out of scope for v1:**

- Backup snapshots (Kopia stays as a separate layer — SyncCenter is sync, not backup).
- Real-time iOS sync at parity with desktop (best-effort via Möbius Sync).
- Multi-tenant / SaaS version.

**Success criteria:**

- A new folder pair can go from "I want to sync X across Mac, QNAP, and GDrive with Node + Python ignore rules" → live sync → in **under 90 seconds** via the UI or `sc` CLI.
- All host configs reproducible from the Git repo on a clean machine.
- Sync state and conflicts visible in Grafana and Claude (via MCP).

---

## 1. Architecture

```
                          ┌──────────────────────────────────────┐
                          │  SyncCenter (QNAP, Docker Compose)   │
                          │  sync.beric.ca via Traefik           │
                          │                                      │
                          │  ┌─────────┐    ┌──────────────┐    │
                          │  │ Web UI  │──▶│ API (Node)   │    │
                          │  │ React + │    │ Express +    │    │
                          │  │ Vite    │    │ SQLite       │    │
                          │  └─────────┘    └──────┬───────┘    │
                          │                       │             │
                          │              ┌────────┼───────┐     │
                          │              │        │       │     │
                          │         ┌────▼──┐ ┌───▼───┐ ┌─▼───┐ │
                          │         │ MCP   │ │ Prom  │ │ CLI │ │
                          │         │ srv   │ │ exptr │ │ sc  │ │
                          │         └───┬───┘ └───┬───┘ └─────┘ │
                          └─────────────┼─────────┼─────────────┘
                                        │         │
                            Claude ─────┘         └────▶ Grafana

   ┌────────────────────────────────────┼──────────────────────────────────────┐
   │                                    │                                      │
   ▼                                    ▼                                      ▼
┌─────────────────────────┐    ┌─────────────────┐               ┌─────────────────────┐
│ Syncthing REST API      │    │ rclone rcd API  │               │  ssh-driven         │
│ port 8384, per device   │    │ port 5572, QNAP │               │  config push        │
│ (Mac, QNAP, Win)        │    │                 │               │  (.stignore, filters)│
└─────────────────────────┘    └─────────────────┘               └─────────────────────┘
   ▲          ▲         ▲              │
   │          │         │              │
┌──┴──┐  ┌────┴───┐ ┌───┴──┐    ┌──────▼──────┐
│ Mac │  │ QNAP   │ │ Win  │    │ Google      │
│ ST  │◀▶│  ST    │◀│  ST  │    │ Drive       │
└─────┘  └────────┘ └──────┘    └─────────────┘
            ▲
            │
     ┌──────┴───────┐
     │ Android/iOS  │  (optional, Syncthing-Fork / Möbius Sync)
     └──────────────┘

┌────────────────────────────────────────────────────────────┐
│  Git repo: synccenter-config (private, on GitHub)          │
│  ├── folders/        folder definitions (YAML)             │
│  ├── rules/          rule sets, with imports               │
│  ├── hosts/          device manifests + API keys (sealed)  │
│  ├── schedules/      cron/rclone job specs                 │
│  ├── imports/        cached github/gitignore templates     │
│  └── compiled/       generated .stignore + filter files    │
│                      (gitignored, written by agents)       │
└────────────────────────────────────────────────────────────┘
```

**Design principles:**

- **Syncthing remains the live-sync engine.** SyncCenter *configures and observes* Syncthing — it does not reimplement it. Same for rclone.
- **The Git repo is the source of truth.** UI edits write back to YAML, commit, and trigger an apply.
- **API keys never leave the repo unsealed.** Use `sops` + `age` for at-rest encryption of secrets.
- **Everything reversible.** Every apply produces a generation; rollback = check out previous commit + re-apply.

---

## 2. Phases & Milestones

### Phase 0 — Foundation (1–2 days)

| Deliverable | Owner |
|---|---|
| Git repo `synccenter-config` initialized, structure scaffolded | `repo-init` agent |
| Device inventory: hostname, OS, IP, role (mesh node / hub / cloud-edge) | manual + `inventory` agent |
| `sops` + `age` set up for secret sealing; team key on QNAP + Mac | manual |
| Traefik route for `sync.beric.ca` declared (not yet pointing anywhere) | manual |
| Decision: QPKG vs Docker for Syncthing on QNAP (recommendation: **Docker via LinuxServer.io** for v2.0 currency) | decision log entry |

**Exit:** Repo exists, you can `git clone` it on every device, secrets sealed.

---

### Phase 1 — Core Sync Layer (2–3 days)

| Deliverable | Owner |
|---|---|
| Syncthing deployed on Mac, QNAP, Windows; all three paired in a 3-node mesh | `infra-deployer` agent |
| inotify watch limit raised on QNAP (`fs.inotify.max_user_watches=524288`), persisted via `/etc/init.d/` autorun | `infra-deployer` |
| rclone installed on QNAP via QPKG or Docker; `rclone rcd` running on `:5572` behind Traefik basic-auth | `infra-deployer` |
| Google Drive remote configured via Service Account (`/share/homes/eric/.config/rclone/sa.json`) | manual + agent |
| Optional: rclone `crypt` remote layered over GDrive for E2E at-rest | optional |
| One test folder pair live: Mac `~/Sync/test` ↔ QNAP `/share/Sync/test` ↔ GDrive `gdrive:Sync/test` | `validator` agent |

**Exit:** Drop a file on Mac → appears on QNAP within seconds, on GDrive within next bisync run (5–15 min default).

---

### Phase 2 — Rule Engine (3–4 days)

| Deliverable | Owner |
|---|---|
| Rule schema (YAML, see §4) finalized and JSON-Schema'd | `rule-compiler` agent |
| Compiler: YAML → `.stignore` + `filter.rclone` (both with `# generated, do not edit` headers) | `rule-compiler` |
| `.gitignore` importer (parses local files, normalizes paths) | `gitignore-importer` agent |
| `github/gitignore` importer (fetches by name: `Node`, `Python`, `macOS`, etc., caches in `imports/`) | `gitignore-importer` |
| Conflict detector: warns when a `.stignore` and rclone filter would diverge | `rule-compiler` |
| Test suite: 12+ golden-file tests (input YAML → expected output) | `validator` |

**Exit:** `sc rules compile <ruleset>` produces correct outputs for Node, Python, macOS, and a custom rule set. Importing `github://Node` works.

---

### Phase 3 — Command Center (5–7 days)

| Deliverable | Owner |
|---|---|
| Node + Express + SQLite API on QNAP (Docker container) | `api-builder` agent |
| REST endpoints: `/folders`, `/rules`, `/hosts`, `/jobs`, `/conflicts`, `/apply` | `api-builder` |
| Polling adapters: Syncthing API per device, rclone rcd API, rsync log scrapers | `api-builder` |
| React + Vite frontend: dashboard, folder editor, rule editor, conflict resolver | `ui-builder` agent |
| Traefik route + Let's Encrypt cert for `sync.beric.ca` | `infra-deployer` |
| `sc` CLI (Node, single bin) — wraps the API for terminal use | `cli-builder` agent |
| Auth: token-based (env-set master token; UI uses session cookie) | `api-builder` |

**Exit:** You can add a folder pair, attach a rule set, and apply — all from the web UI. The dashboard shows all 3+ hosts and their sync state.

---

### Phase 4 — MCP + Observability (2–3 days)

| Deliverable | Owner |
|---|---|
| MCP server exposing tools: `list_folders`, `list_conflicts`, `pause_folder`, `resume_folder`, `trigger_bisync`, `compile_rules`, `apply` | `mcp-publisher` agent |
| Server registered in Claude Desktop and Claude Code MCP config | manual |
| Prometheus exporter at `/metrics` — folder state, files in sync, files in conflict, last bisync duration, errors | `api-builder` |
| Grafana dashboard JSON committed; folders panel, conflicts panel, throughput panel | `dashboard-builder` agent |
| Alerts: conflict count > 0 for > 1h, bisync failure, device offline > 15m | `dashboard-builder` |

**Exit:** Claude can answer "what's syncing right now and are there any conflicts?" via MCP. Grafana shows live sync metrics.

---

### Phase 5 — Hardening (2–3 days)

| Deliverable | Owner |
|---|---|
| All API keys rotated post-development, sealed in repo via sops | manual |
| Permissions audit on QNAP: Syncthing user owns its shares, no world-writable directories | `validator` |
| Backup of `synccenter-config` repo to GDrive via Kopia (separate from sync layer) | `infra-deployer` |
| Disaster-recovery runbook: "how to rebuild from repo on a fresh QNAP" | `docs-writer` agent |
| End-to-end test: kill the QNAP container, restore from compose + repo, verify mesh recovers | `validator` |

**Exit:** A fresh clone of the repo + the QNAP `docker-compose.yml` reproduces the full system without manual tweaking.

---

## 3. Claude Code Agent Roster

Each agent is a sub-agent definition under `.claude/agents/` in the SyncCenter dev repo (separate from `synccenter-config`). Each has a focused system prompt, an allowed tool list, and a clear handoff contract.

| Agent | Role | Allowed tools | Reads | Writes |
|---|---|---|---|---|
| `repo-init` | Scaffold `synccenter-config` structure, JSON schemas, `.gitignore`, `.sops.yaml` | Bash, Edit, Write | — | Repo files |
| `infra-deployer` | SSH into QNAP, manage Docker Compose, manage `launchd`/systemd on Mac/Win | Bash, SSH, Edit | host manifests | systemd units, compose files |
| `rule-compiler` | YAML rules → `.stignore` + rclone filter | Read, Write | `rules/*.yaml` | `compiled/*` |
| `gitignore-importer` | Pull from `github/gitignore`, parse local `.gitignore`, normalize | WebFetch, Read, Write | URLs, local paths | `imports/*` |
| `api-builder` | Node/Express API, SQLite schema, adapters | Bash, Edit, Write, Test | API specs | `apps/api/**` |
| `ui-builder` | React + Vite frontend, Tailwind | Bash, Edit, Write | API contract | `apps/web/**` |
| `cli-builder` | `sc` CLI binary | Bash, Edit, Write | API contract | `apps/cli/**` |
| `mcp-publisher` | MCP server wrapping the API | Bash, Edit, Write | API contract | `apps/mcp/**` |
| `dashboard-builder` | Grafana JSON, Prom alert rules | Edit, Write | metrics catalog | `observability/**` |
| `validator` | Run e2e sync tests, golden-file tests, smoke after each apply | Bash, Test | everything | test reports |
| `docs-writer` | Keep `README.md`, runbooks, `CHANGELOG.md` in sync with code | Read, Write | all | `docs/**` |

**Orchestration pattern:**

A top-level `planner` (you, or a planner agent in Claude Code) routes each task to the right sub-agent. Phase 1 example flow:

```
planner → infra-deployer ("install Syncthing on QNAP via Docker")
       → infra-deployer ("install Syncthing on Mac via Homebrew + launchd")
       → infra-deployer ("install Syncthing on Windows via SyncTrayzor v2")
       → infra-deployer ("pair the three devices, verify via API")
       → validator    ("create test folder, drop file, assert propagation")
       → docs-writer  ("update runbook with the install steps actually used")
```

Each agent commits its work to a feature branch; planner opens the PR and merges after validator passes.

---

## 4. Rule Engine — Format Spec

A **ruleset** is a YAML file under `rules/`. Folders reference rulesets by name.

```yaml
# rules/dev-monorepo.yaml
name: dev-monorepo
description: Standard ignores for full-stack dev folders
version: 1

imports:
  - github://github/gitignore/Node
  - github://github/gitignore/Python
  - github://github/gitignore/macOS
  - file://./local-secrets.txt    # additional patterns from a plain file
  - ruleset://base-binaries       # another ruleset in this repo

# Anything in `imports` is merged first; later entries win on conflict.

excludes:
  - .DS_Store
  - "**/*.log"
  - "**/node_modules/"
  - "**/.venv/"
  - "**/dist/"
  - "**/.next/"
  - "**/__pycache__/"
  - "**/coverage/"
  - "**/.env"
  - "**/.env.*"

includes:
  # Negations — keep these even if a previous rule excluded them
  - "!.env.example"
  - "!docs/**/*.log"   # whitelist log examples in docs

# Per-engine overrides for cases where the unified pattern can't express
# something both engines support identically.
engine_overrides:
  syncthing:
    extra:
      - "(?d)*.tmp"      # Syncthing-specific: delete on receive
  rclone:
    extra:
      - "+ *.important"  # rclone include syntax
      - "- *"            # rclone catch-all
```

**Compiler behavior:**

- **Imports resolved first**, top-down, with later imports overriding earlier ones (gitignore-style: last match wins).
- **Patterns normalized** to POSIX-style forward slashes regardless of source.
- **`.stignore` output** uses gitignore syntax natively. Includes use `!` prefix.
- **rclone filter output** translates: `excludes` → `- pattern`, `includes` → `+ pattern`, with an implicit `+ **` at the end unless overridden.
- **A header is prepended** to every generated file:
  ```
  # GENERATED BY synccenter — do not edit
  # source: rules/dev-monorepo.yaml @ commit abc1234
  # generated: 2026-05-14T10:30:00Z
  ```
- **Conflict detection:** if a pattern would behave differently in `.stignore` vs rclone (e.g. a Syncthing regex that rclone doesn't support), the compiler emits a warning and refuses to write the file unless `--allow-divergent` is passed.

**Importers:**

- `github://github/gitignore/<NAME>` → fetches `https://raw.githubusercontent.com/github/gitignore/main/<NAME>.gitignore`, caches in `imports/github-gitignore/<NAME>.gitignore` (refresh weekly).
- `file://<path>` → reads a local file (gitignore syntax assumed).
- `ruleset://<name>` → references another ruleset in `rules/`.
- `url://<https-url>` → arbitrary HTTPS fetch (with SHA-256 pinning option).

---

## 5. Folder Definitions

```yaml
# folders/code-projects.yaml
name: code-projects
ruleset: dev-monorepo
type: send-receive   # send-receive | send-only | receive-only | receive-encrypted

paths:
  mac-studio:    /Users/eric/Code
  qnap-ts453d:   /share/Sync/code
  win-desktop:   C:\Users\eric\Code

cloud:
  rclone_remote: gdrive
  remote_path:   sync/code
  bisync:
    schedule: "*/15 * * * *"   # every 15 minutes
    flags:
      - --resilient
      - --recover
      - --max-lock=2m
      - --conflict-resolve=newer
      - --compare=size,modtime,checksum

versioning:
  type: staggered   # off | trash | simple | staggered
  params:
    maxAge: 30d

ignore_perms: true                # cross-platform: Mac/Win/Linux perms differ
fs_watcher_enabled: true
fs_watcher_delay_s: 10
```

When you `sc apply folders/code-projects.yaml`:

1. Compiler renders `compiled/code-projects/.stignore` and `compiled/code-projects/filter.rclone`.
2. `infra-deployer` agent pushes `.stignore` into each device's folder via SSH (or via Syncthing's `/rest/db/ignores` API, preferred).
3. API creates/updates the folder via each host's Syncthing API; sets type, versioning, watcher.
4. API writes/updates the rclone bisync cron entry on the QNAP.
5. Validator runs a smoke test (touch a file, watch it propagate).
6. Result + diff committed back to `synccenter-config`.

---

## 6. Repo Structure

```
synccenter-config/                 # The GitOps repo (what gets applied)
├── README.md
├── .sops.yaml
├── folders/
│   ├── code-projects.yaml
│   ├── photos.yaml
│   └── laundromat-ops.yaml
├── rules/
│   ├── dev-monorepo.yaml
│   ├── photos.yaml
│   └── base-binaries.yaml
├── hosts/
│   ├── mac-studio.yaml
│   ├── qnap-ts453d.yaml
│   └── win-desktop.yaml
├── secrets/
│   ├── syncthing-api-keys.enc.yaml   # sops-encrypted
│   └── rclone-sa.enc.json
├── schedules/
│   └── bisync-jobs.yaml
├── imports/                          # cached, refreshed weekly
│   ├── github-gitignore/
│   └── checksums.json
└── compiled/                         # gitignored
    ├── code-projects/
    │   ├── .stignore
    │   └── filter.rclone
    └── ...

synccenter/                        # The application repo (the tool itself)
├── README.md
├── docker-compose.yml             # for QNAP deploy
├── .claude/
│   └── agents/
│       ├── infra-deployer.md
│       ├── rule-compiler.md
│       ├── api-builder.md
│       └── ...
├── apps/
│   ├── api/                       # Node + Express + SQLite
│   ├── web/                       # React + Vite + Tailwind
│   ├── cli/                       # `sc` binary (Node)
│   └── mcp/                       # MCP server
├── packages/
│   ├── rule-compiler/             # YAML → .stignore + rclone filter
│   ├── importers/                 # gitignore, github, file, url
│   ├── adapters/                  # Syncthing API client, rclone rcd client
│   └── schema/                    # JSON Schema for all YAML files
├── observability/
│   ├── prometheus/
│   └── grafana/
└── tests/
    ├── golden/                    # rule compiler golden files
    └── e2e/                       # sync propagation tests
```

Two separate repos so config can be private/personal while the tool can be shared (or open-sourced later).

---

## 7. Command Center — UI Sketch

**Dashboard (`/`):**

- Top row: device cards (Mac, QNAP, Win) with online status, version, last-seen, throughput sparkline.
- Middle: folder list with state (Idle / Syncing / Out of Sync / Conflict), file counts, last sync time.
- Right rail: recent conflicts feed, with one-click "resolve newer / older / keep both".

**Folder editor (`/folders/:name`):**

- YAML editor with schema-aware autocomplete (Monaco).
- "Attached ruleset" picker, with a preview of compiled `.stignore` side-by-side.
- "Apply" button → diffs the current vs new config, shows what will change, then applies.

**Rules editor (`/rules/:name`):**

- Same Monaco editor.
- "Import from GitHub gitignore" button → searchable picker of all 200+ templates.
- "Test against folder" → pick a path, see which files would be ignored/included.

**Conflicts (`/conflicts`):**

- Aggregated list across all folders.
- File preview (text diff for text, metadata for binary).
- Bulk resolve actions.

---

## 8. MCP Tool Surface

The MCP server exposes these tools to Claude:

| Tool | Purpose |
|---|---|
| `sc_list_folders` | All folders, their state, host coverage |
| `sc_get_folder` | Single folder detail (config + state) |
| `sc_list_conflicts` | Active conflicts across all folders |
| `sc_resolve_conflict` | Pick newer/older/keep-both/manual for a conflict |
| `sc_pause_folder` / `sc_resume_folder` | Pause/resume sync on one or all hosts |
| `sc_trigger_bisync` | Force-run an rclone bisync now |
| `sc_compile_rules` | Compile a ruleset, return diff vs deployed |
| `sc_apply` | Apply a folder or ruleset change (with dry-run flag) |
| `sc_recent_changes` | Last N file changes seen by Syncthing |
| `sc_health` | Aggregate health: devices online, folders idle, errors |

---

## 9. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Syncthing 2.x QPKG lag → install path fragmentation | Medium | Medium | Standardize on Docker via LinuxServer.io; QPKG only as fallback |
| Google Drive 2-files/sec rate limit chokes large initial bisync | High | Medium | Seed via `rclone copy` with `--transfers=4 --tpslimit=2` overnight; bisync only after initial seed |
| Bisync conflicts on large frequently-edited folders | Medium | High | Default `--conflict-resolve=newer` + versioning; conflicts surfaced in UI within 15 min |
| Permission mismatches on cross-platform folders | High | Medium | `ignore_perms: true` on all cross-platform folders |
| QNAP firmware update wipes cron / `/etc` overlays | Medium | High | Cron via `/etc/config/crontab`; compose state on `/share` volume |
| `.stignore` and rclone filter drift silently | Medium | High | Compiler conflict detector; both files from one pass |
| Loss of `synccenter-config` repo | Low | Critical | GitHub remote + Kopia backup of repo to GDrive |
| MCP server exposes destructive ops to Claude unintentionally | Low | High | All mutating tools require `confirm: true`; UI audit log |
| inotify limit hit on large folders | High | Low | Raised to 524288 in Phase 1; alerted in Grafana |

---

## 10. Quick-Start Checklist (Day 1)

- [ ] Create `synccenter-config` repo on GitHub (private)
- [ ] Create `synccenter` dev repo locally; run `repo-init` agent to scaffold both
- [ ] Generate `age` keypair for sops; commit public key, store private in 1Password
- [ ] Install Syncthing via Docker on QNAP (LinuxServer.io image, `PUID=1000`, ports 8384/22000/21027)
- [ ] Install Syncthing on Mac via Homebrew (`brew install syncthing` + `brew services start`)
- [ ] Install Syncthing on Windows via SyncTrayzor v2 (GermanCoding fork)
- [ ] Pair the three devices manually via GUI (one-time bootstrap)
- [ ] Install rclone via QPKG on QNAP; configure GDrive remote with Service Account
- [ ] Start `rclone rcd --rc-addr=127.0.0.1:5572 --rc-user=... --rc-pass=...`
- [ ] Bump inotify limit on QNAP; persist via `/etc/init.d/autorun.sh`
- [ ] Add Traefik label for `sync.beric.ca` → SyncCenter container (placeholder)
- [ ] Verify: drop a file in a hand-created Syncthing folder, watch it land on the other two
- [ ] Tag this as `phase-1-complete` in both repos

---

## Appendix A — Engine Comparison Cheat Sheet

| Capability | Syncthing | rclone |
|---|---|---|
| Live bidir sync | continuous P2P mesh | bisync is scheduled |
| Google Drive | no | native |
| Filter syntax | `.stignore` (gitignore-compat) | `--filter-from` (`+/-` prefixed) |
| Negations | `!pattern` | `+ pattern` before `- pattern` |
| Regex support | `(?d)`, `(?i)` prefixes | `{...}` glob, limited regex |
| Daemon mode | yes (always) | yes (`rcd`) |
| REST API | yes (`:8384`) | yes (`:5572`) |
| Resource cost | 200 MB–1 GB RAM | 50–300 MB transient |
| Best for | Live device-to-device mesh | Cloud edge (GDrive) + scheduled cross-cloud |

**SyncCenter uses Syncthing for everything device-to-device and rclone for everything cloud-bound.**

---

## Appendix B — Where this plugs into your existing stack

- **Traefik** — already routing `*.beric.ca`. Add label for `sync.beric.ca` → SyncCenter container.
- **Grafana** — already at `grafana.beric.ca`. SyncCenter ships a Prometheus exporter and a dashboard JSON.
- **Netdata + Prometheus stack** — SyncCenter's `/metrics` becomes a new scrape target.
- **MCP** — alongside existing Grafana and Netdata MCP servers wired to Claude.
- **Kopia** — runs independently, backing up `synccenter-config` to GDrive on a daily schedule.
- **Custom `wt` (git worktree) tool** — `sc` CLI follows the same philosophy.

---

## Appendix C — Suggested Claude Code kickoff prompt

```
You are the planner for SyncCenter, defined in ./docs/SyncCenter-Project-Plan.md.

Read the plan, then:
1. Scaffold both repos (synccenter for the tool, synccenter-config for state)
2. Create the .claude/agents/ directory with one .md file per agent listed in §3
3. Each agent file: role, allowed tools, read/write scopes, handoff contract
4. Stop after scaffolding. Do not deploy anything yet.

Commit at the end with message "phase-0: scaffold".
```

From there, drive each phase with: `Execute Phase N from the plan. Use the appropriate agents.`

---

*End of plan. Phase 0 scaffolding executes from here.*
