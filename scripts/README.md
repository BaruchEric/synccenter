# scripts/

Operator scripts. The runbooks in `docs/runbooks/` drive when each is run.

| Script | Run on | When |
|---|---|---|
| `qnap-bootstrap.sh` | QNAP (as root) | Phase 1 Step 3 — installs Syncthing + rclone-rcd via docker compose, raises inotify limit, prints the QNAP's device ID + API key. |
| `seed-host-secrets.sh` | Operator workstation | Phase 1 Step 6 — collects Syncthing identities from the operator, sops-encrypts them, writes `synccenter-config/secrets/syncthing-{api-keys,device-ids}.enc.yaml`. |

Each script is idempotent. Re-run any time to refresh — `seed-host-secrets.sh` after key rotation, `qnap-bootstrap.sh` after firmware updates or compose tweaks.
