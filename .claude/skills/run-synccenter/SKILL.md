---
name: run-synccenter
description: Build, launch, drive, and screenshot SyncCenter locally — the API (:3000), the React dashboard (:5173), and the `sc` CLI. Use when asked to run, start, serve, smoke-test, screenshot, or verify a change in the real SyncCenter app rather than only its tests.
---

# Run SyncCenter

Bun monorepo, four apps sharing one setup: `apps/api` (Express + `bun:sqlite`),
`apps/web` (React + Vite dashboard), `apps/cli` (the `sc` binary), `apps/mcp`.
The agent path is **`.claude/skills/run-synccenter/driver.mjs`** — it decrypts
the sealed env, launches API + web detached, polls both for health, and
smoke-tests the endpoints. Drive the UI afterwards with the Chrome MCP tools.

All paths below are relative to the repo root (`services/synccenter/`).
The driver `cd`s to the repo root itself, so it works from any cwd.

## Prerequisites

Already present on this Mac; a fresh machine needs:

```bash
brew install oven-sh/bun/bun sops age
bun install                       # 277 packages
```

State lives at `$TMPDIR/synccenter-run/` (pidfiles, logs, a throwaway SQLite
db). Nothing is written into the repo.

## Config + secrets

The API refuses to boot without `SC_CONFIG_DIR` and an `SC_API_TOKEN` of at
least 16 chars. Both come from the **sibling config repo**, which must be
checked out next to this one:

```
services/synccenter/          ← this repo
services/synccenter-config/   ← folders/, rules/, hosts/, secrets/
```

The token is sealed in `../synccenter-config/secrets/api-env.enc.yaml` and
decrypted with SOPS + age. The driver does this for you; it needs the age key:

```bash
export SOPS_AGE_KEY_FILE=$HOME/.config/sops/age/keys.txt   # driver's default
```

Point at a config repo elsewhere with `SC_CONFIG_DIR=/path/to/synccenter-config`.

## Run (agent path) — start here

```bash
bun .claude/skills/run-synccenter/driver.mjs up      # start both, wait for health
bun .claude/skills/run-synccenter/driver.mjs up --fake-rclone   # + a simulated rcd on :5572
bun .claude/skills/run-synccenter/driver.mjs smoke   # 7 assertions, exit 0 = pass
bun .claude/skills/run-synccenter/driver.mjs logs    # last 25 lines of each
bun .claude/skills/run-synccenter/driver.mjs down    # stop both
```

`up` prints:

```
• api pid 28149 → /var/folders/.../T/synccenter-run/api.log
• web pid 28150 → /var/folders/.../T/synccenter-run/web.log
✓ api up at http://localhost:3000/health
✓ web up at http://localhost:5173/

  API  http://localhost:3000      (bearer: driver.mjs token)
  UI   http://localhost:5173      (React dashboard; proxies /api → :3000)
```

`smoke` covers public health, that auth is enforced (expects 401), authed
`/folders`, a folder manifest, `/hosts`, that Vite serves the SPA, and that the
Vite `/api` proxy reaches the API:

```
✓ health (public) → 200 {"ok":true,"version":"0.0.1"}
✓ auth is enforced (expect 401) → 401 {"error":"missing Bearer token"}
✓ folders (authed) → 200 {"folders":["arik","baruchrio",...]}
✓ vite proxies /api → API → 200 {"ok":true,"version":"0.0.1"}

all smoke checks passed
```

### Live progress: `--fake-rclone`

The real rcd **is** published, but only on the NAS's own loopback
(`docker port rclone-rcd` → `5572/tcp -> 127.0.0.1:5572`), and QTS ships
`AllowTcpForwarding no`, so `ssh -L` to it connects and then resets. Do **not**
hand-edit `/etc/config/ssh/sshd_config` to change that: QTS regenerates the file
from Control Panel settings, so the edit does not stick, and a failed sshd
restart locks you out of the only channel that can repair it — restoring SSH then
needs the QTS web UI (Control Panel → Network & File Services → Telnet / SSH).
So `SC_RCLONE_URL` stays unset locally and every run/progress endpoint 503s.
`up --fake-rclone` starts **`fake-rcd.mjs`** on :5572 and points the API at it.

Real rclone progress instead comes from the deployed API, which reaches the rcd
over the compose network. Serve the dashboard there with
`scripts/deploy-web.sh` and use `https://sync.beric.ca/app/activity`.

It is not just a stub — it reproduces the two behaviours that make bisync
progress awkward:

- a **12s listing phase** where `totalBytes` is 0 while `checks`/`listed`
  climb, then **23s of transferring**. A real local bisync finishes in under a
  second, which is useless for building a meter. `--fast` scales this to ~7s.
- stats served **only under the caller's `_group`**, so a client that guesses
  `job/<jobid>` sees zeros — exactly like the real thing.

```bash
bun .claude/skills/run-synccenter/driver.mjs up --fake-rclone
# then POST /folders/<name>/bisync?async=true → { runId, jobid }
#      GET  /runs/<runId>      → phase: starting|checking|transferring|finished
#      GET  /events            → SSE; run + folder events
#      POST /runs/<runId>/stop → cancel
```

### Driving the dashboard in a browser

The UI wants a bearer token pasted into a sign-in field (stored in
`localStorage`, so it persists across reloads). **Never type the token as a
literal** in a tool call — it lands in the transcript. Put it on the clipboard
and paste:

```bash
bun .claude/skills/run-synccenter/driver.mjs token | pbcopy
```

Then with the Chrome MCP tools: `navigate` to `http://localhost:5173/`, locate
the field with `find` (**not** screenshot coordinates — see Gotchas), click by
`ref`, `key` `cmd+v`, `key` `Return`. Useful routes once signed in:

| Route | Shows |
|---|---|
| `/` | dashboard tiles: API status, host count, folder count, conflicts |
| `/folders` | folder list |
| `/activity` | the timeline; live runs render at the `now` line with a progress meter |
| `/folders` | list + Edit / Run / Apply / Pause / Disable / Delete per row |
| `/folders/new`, `/folders/arik/edit` | the manifest editor |
| `/folders/arik` | manifest JSON + live per-host state + Dry-run/Apply/Pause/Resume |
| `/rules`, `/hosts`, `/conflicts` | ruleset, host, conflict views |

## Run: the `sc` CLI

Local-only subcommands (compile, folder plans) need just `--config`:

```bash
bun run apps/cli/src/index.ts --config ../synccenter-config folders list
bun run apps/cli/src/index.ts --config ../synccenter-config rules compile arik-share
bun run apps/cli/src/index.ts --config ../synccenter-config rules compile arik-share --stdout
```

Anything that touches live hosts also needs the age key, because it resolves
device IDs from sealed secrets:

```bash
export SOPS_AGE_KEY_FILE=$HOME/.config/sops/age/keys.txt
bun run apps/cli/src/index.ts --config ../synccenter-config schedule render
bun run apps/cli/src/index.ts --config ../synccenter-config folders apply arik --dry-run
```

## Run (human path)

Two terminals, no driver:

```bash
# terminal 1 — needs SC_CONFIG_DIR + SC_API_TOKEN exported first
bun run apps/api/src/index.ts
# terminal 2
cd apps/web && bun run dev
```

Ctrl-C each. The driver exists because assembling that env by hand is the slow
part.

## Test / typecheck / build

```bash
bun test              # 231 tests across 23 files
bun run typecheck     # 9 packages, all must exit 0
bun run build         # vite build for apps/web
bun run lint          # stub: prints "lint: configure in phase 3"
```

## Gotchas

- **Vite binds IPv6 only.** `curl http://127.0.0.1:5173/` returns `000`
  (connection refused); `http://localhost:5173/` returns 200. `lsof` confirms
  `TCP [::1]:5173 (LISTEN)`. Use `localhost` everywhere — the API on :3000 is
  reachable both ways, so one hostname works for both.
- **Don't click browser fields by screenshot coordinates.** The Chrome window
  resizes between calls (1107px → 1132px wide here), so coordinates from one
  screenshot miss on the next. `find` the element and click by `ref`.
- **`folder-state` and other remote-mode CLI commands need a running API**
  (`SC_API_URL` / `--api`), unlike `folders list` / `rules compile`, which read
  the config repo directly. `folder-state` without it fails with
  `no API URL — pass --api <url>`.
- **`rules compile` writes by default**; the flag to inspect without writing is
  `--stdout`. There is no `--write` or `-o`.
- **`folders apply` refuses on drift.** If live host state diverges from the
  manifest it exits with `DRIFT: divergent fields` and dumps both lists. That
  is the guard working — re-run with `--force` only when the manifest is
  authoritative. `--prune` additionally deletes live-only folders; leave it off
  unless you mean it.
- **A ruleset change needs two deployments.** `sc apply` pushes `.stignore` to
  Syncthing hosts; the rclone `filter.rclone` is a *separate* artifact that has
  to be copied to the anchor host. Doing one and assuming both is how stale
  ignores survive a "fix" — verify with
  `curl -H "X-API-Key: $KEY" $HOST/rest/db/ignores?folder=<name>`.
- **A local API can reach the Mac's Syncthing; the deployed one cannot.** The
  Mac binds its GUI to `127.0.0.1:8384`, so the QNAP-hosted API shows
  `mac-studio unreachable` while this local run resolves both hosts. Run
  locally when you need true per-host state.
- **The compiled rclone filter is keyed by RULESET, not folder.** It lives at
  `compiled/<ruleset>/filter.rclone` — two folders sharing a ruleset share one
  artifact. Deriving the path from the folder name makes every bisync 409 with
  `filter.rclone missing`. Go through `rcloneFilterPath()` in
  `apps/api/src/lib/plan.ts`.
- **rclone progress needs a `_group` you choose.** `core/stats?group=job/<jobid>`
  returns all zeros for bisync; only a caller-supplied `_group` (SyncCenter uses
  `sc/bisync/<folder>/<uuid>`, stored on the run row) carries real counters.
  Verified against rclone 1.75 on the live rcd.
- **The run tracker is built but not started by `buildApp`.** `index.ts` calls
  `tracker.start()`; tests drive `tracker.tick()` by hand. Starting it in
  `buildApp` would leave an interval in every test and hang the suite.
- **A dead server does not close the SSE socket.** Through Vite (and Traefik /
  Cloudflare) the connection stays open and simply goes quiet, so the client
  cannot rely on `read()` rejecting — it watches for >26s of silence against a
  10s server heartbeat. If you change one, change the other.
- **`oven/bun:1.1-alpine` cannot parse this repo's `bun.lock`** (`Unknown
  lockfile version`). The deployed container needs `oven/bun:1-alpine`.
  Irrelevant locally, but it will bite you in Docker.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `missing required env var: SC_CONFIG_DIR` | The sibling `synccenter-config` isn't where the driver looked. Pass `SC_CONFIG_DIR=/abs/path`. |
| `sops decrypt failed` / `no age key at …` | `export SOPS_AGE_KEY_FILE=$HOME/.config/sops/age/keys.txt`. |
| `SC_API_TOKEN must be at least 16 characters` | The sealed env decrypted to something empty — check `sops -d ../synccenter-config/secrets/api-env.enc.yaml`. |
| `web never became healthy` but the log says `ready in 149 ms` | You (or a check) used `127.0.0.1:5173`. Use `localhost`. |
| Port already in use after a crash | `driver.mjs down` — it clears pidfiles and also `pkill`s stragglers, because `bun run dev` execs vite as a grandchild that outlives the shell. |
| `unknown format "uri" ignored in schema` on every CLI call | Harmless AJV noise about the host schema. Filter with `grep -v 'unknown format'`. |
| `rclone is not configured (set SC_RCLONE_URL)` on `/runs`, `/rclone/*` or bisync | Restart with `up --fake-rclone`. The sealed env has no `SC_RCLONE_URL` because the real rcd isn't reachable from here. |
| Bisync 409s with `filter.rclone missing at …/compiled/<folder>/…` | The path is keyed by ruleset. Either apply the folder first, or check you aren't re-deriving the path from the folder name. |
| The lamp says `polling` and stays there | Expected right after an API restart: the client retries the stream once a minute. It flips back to `live` on its own. |
