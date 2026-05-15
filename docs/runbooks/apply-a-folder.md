# Apply a folder

Push a folder's compiled `.stignore` to every Syncthing host in its `paths:` map and trigger a rescan.

## Preflight

```sh
# 1. Imports cached?
sc imports list

# If anything's ✗, refresh:
sc imports refresh
```

## Dry run

Look before you leap. Returns the previews + per-host plan without touching daemons.

```sh
sc apply <folder> --dry-run
# or, from the web UI: folders/<name> → Dry-run
# or, via the API:
curl -X POST -H "Authorization: Bearer $SC_TOKEN" \
  "$SC_API_URL/folders/<folder>/apply?dryRun=true" | jq
```

Inspect `stignorePreview` and `rclonePreview`. Confirm the patterns match intent.

## Apply

```sh
sc apply <folder>
```

Behavior:
- For each host in `folders/<folder>.yaml#paths`:
  - `setIgnores` against the host's Syncthing API
  - `scan` to pick up the new ignores immediately
- Records to `apply_history` (audit log).
- Returns 200 on full success, 207 on partial. Per-host status in the response.

## On failure

A 207 means one or more hosts failed (`ok: false`, with `error`). Common causes:
- Host's Syncthing API key not in env → set `SC_HOST_API_KEY_<HOST>` and restart the container.
- Host offline → `sc host-status <host>` to verify.
- Folder not yet registered on that host's Syncthing → bootstrap via the Syncthing GUI once (or use `addFolder` directly via the adapter — not yet exposed by the API).

## After apply

Verify with `sc folder-state <folder>` — every host should report `state: idle` once the rescan settles.

Trigger the cloud edge if the folder has one:

```sh
sc bisync trigger <folder>
```

This uses the just-deployed compiled filter. Returns immediately with a jobid if `--async`.

## Roll back

The compiled state lives in `synccenter-config/compiled/<folder>/`. Revert the source YAML in git and re-run `sc apply <folder>` — the compiler is deterministic given commit SHA + inputs.
