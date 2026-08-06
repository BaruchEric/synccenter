#!/usr/bin/env bash
# Ship the React dashboard (and the API source it rides along with) to the QNAP.
#
# The API container bind-mounts the source read-only:
#   /share/Container/synccenter/code  ->  /srv/synccenter:ro
# so deploying is an rsync plus a restart. There is no image to build.
#
#   ./scripts/deploy-web.sh            # build, rsync, restart, verify
#   ./scripts/deploy-web.sh --dry-run  # show what rsync would change
#
# Requires SSH to the NAS. QTS ships AllowTcpForwarding=no and regenerates
# /etc/config/ssh/sshd_config from Control Panel settings, so do NOT hand-edit
# that file — a failed sshd restart locks you out of the only channel that can
# fix it. Nothing here needs port forwarding.
set -euo pipefail

NAS="${NAS:-admin@192.168.1.10}"
DEST="${DEST:-/share/Container/synccenter/code}"
DOCKER="/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY=""
[[ "${1:-}" == "--dry-run" ]] && DRY="--dry-run"

cd "$REPO"

echo "==> building the dashboard for the /app mount"
# Always built here rather than trusted from the working tree: a plain
# `bun run build` emits root-relative asset URLs that 404 under /app and render
# a blank page. The API warns about this at boot, but not shipping it is better.
bun run --cwd apps/web build:deploy >/dev/null
grep -q '"/app/assets/' apps/web/dist/index.html 2>/dev/null \
  || grep -q '/app/assets/' apps/web/dist/index.html \
  || { echo "FATAL: built index.html does not reference /app/assets/ — refusing to ship" >&2; exit 1; }
echo "    ok: $(grep -oE '/app/assets/[^\"]+\.js' apps/web/dist/index.html | head -1)"

echo "==> rsync -> $NAS:$DEST"
# node_modules is deliberately excluded: the container runs `bun run` against a
# read-only mount and resolves deps from its own image layer.
rsync -az --delete $DRY \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '*.tsbuildinfo' \
  --exclude '.claude' \
  ./ "$NAS:$DEST/"

if [[ -n "$DRY" ]]; then echo "(dry run — nothing restarted)"; exit 0; fi

echo "==> checking the container has SC_WEB_DIR"
if ! ssh "$NAS" "$DOCKER inspect synccenter-api --format '{{range .Config.Env}}{{println .}}{{end}}'" \
     | grep -q '^SC_WEB_DIR='; then
  cat >&2 <<'MSG'

SC_WEB_DIR is not set on synccenter-api, so /app will not be mounted.
Add this line to the NAS compose file's synccenter-api environment block:

      SC_WEB_DIR: /srv/synccenter/apps/web/dist

then recreate the container:

  docker compose --env-file .env up -d synccenter-api

The NAS compose file is authoritative; the copy in this repo has drifted from it
before, so edit the NAS one in place rather than overwriting it.
Code is already rsynced, so that is the only remaining step.
MSG
  exit 2
fi

echo "==> restarting synccenter-api"
ssh "$NAS" "$DOCKER restart synccenter-api" >/dev/null

echo "==> verifying https://sync.beric.ca/app/"
for i in $(seq 1 12); do
  code="$(ssh "$NAS" "$DOCKER exec synccenter-api sh -c 'command -v wget >/dev/null && wget -qS -O /dev/null http://127.0.0.1:3000/app/ 2>&1 | head -1'" 2>/dev/null || true)"
  case "$code" in
    *200*) echo "    ok: container serves /app/"; exit 0 ;;
  esac
  sleep 3
done
echo "WARNING: /app/ did not return 200 from inside the container; check: $DOCKER logs --tail 40 synccenter-api" >&2
exit 1
