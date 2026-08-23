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


## Adding a brand-new folder, end to end

What it took to add `memory-vault` on 2026-08-22; the steps above assume the
folder already exists on every host, this list does not.

1. Author `rules/<ruleset>.yaml` and `folders/<folder>.yaml` in
   `synccenter-config`. If the NAS member is (or will become) a QTS share,
   exclude `@Recycle/`, `@Recently-Snapshot/` and `@Transcode/` from day
   one (or import `hbs-parity`): a share with its recycle bin on keeps an
   `@Recycle/` with a `desktop.ini` at its root, recreated on demand, and
   Syncthing will replicate it to every member otherwise. Also exclude
   `.stfolder/`, `.stversions/` and `.stignore` when the ruleset does not
   drop dot-paths; Syncthing skips them itself, rclone does not.
2. `sc rules compile <ruleset>`, `sc folders plan <folder>`, then
   `sc folders apply <folder> --dry-run`. Local mode decrypts host secrets
   with sops, which on the Mac needs
   `SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt`.
3. Create the NAS directory owned by uid 1000 (Syncthing's PUID).
   `/share/<Name>` symlinks exist only for QTS shares, so either create the
   share first (`/sbin/addshare <Name> /share/CACHEDEV1_DATA/<Name> -aw -uw:<user>`)
   or point the manifest at the volume path `/share/CACHEDEV1_DATA/<name>`.
4. `sc folders apply <folder>` adds the peer devices, the folder and the
   ignores on every Syncthing member, and since 2026-08-22 the `versioning:`
   block too (`maxAge: 30d` lands as Syncthing's `"2592000"`). Before that fix
   the planner dropped the block and apply re-POSTed the folder, which
   Syncthing treats as a replace, so every apply reset versioning to none;
   read it back once with `GET /rest/config/folders/<id>` if the API on the
   QNAP predates the fix.
5. Copy the compiled filter to
   `/share/Container/synccenter/rclone-config/filters/<ruleset>.rclone` on the
   QNAP and rsync the config repo (minus `.git`) to
   `/share/CACHEDEV1_DATA/synccenter-config`; the API reads that copy.
6. Once the NAS member reports `needFiles: 0`, seed the Drive leg:
   `rclone mkdir <remote>:<path>`, then the crontab command with `--resync`
   and a dated `--log-file`.
7. Hand-install the cron line in `/etc/config/crontab` (back the file up,
   tag the line `# synccenter:<folder>:<remote>`, reload with
   `crontab /etc/config/crontab`). `schedules/` is not materialized
   automatically today.
8. After any later ruleset change: `sc folders apply <folder> --force` (the
   drift guard compares live ignores against the new compile and refuses
   without it), redeploy the filter, run a `--resync` (bisync stores the
   filter md5 and aborts otherwise). Never delete a freshly ignored path on one
   member before the ignore is live on every member: the delete propagates and
   the other member sticks on "directory has been deleted on a remote device
   but contains ignored files". Fix: prepend `(?d)<path>/**` to that member's
   ignores with `POST /rest/db/ignores`, let the delete settle, then re-apply
   to restore the canonical list.
