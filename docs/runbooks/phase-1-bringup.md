# Phase 1 — Core Sync Layer bring-up

Brings Syncthing live on Mac + QNAP + Windows, installs rclone on the QNAP, configures Google Drive, and proves a test file propagates Mac → QNAP → GDrive.

**Time:** 60–90 minutes if everything cooperates. Most of it is waiting for daemons to settle.

**Prerequisites:**
- SSH access to the QNAP as a user that can run `docker compose`. Test with `ssh <qnap-host> docker ps` first.
- Homebrew on the Mac.
- A laptop / desktop you can drive the Windows install from.
- A Google Cloud project where you can create a Service Account (free).
- This repo + `../synccenter-config` cloned on the Mac (the operator workstation).

> All commands below run from the **Mac** unless prefixed with `# on QNAP:` or `# on Windows:`.

---

## Step 1 — Generate the `age` keypair (sops)

This is the master key that decrypts secrets on every machine that needs them. Lose it and you re-key every secret.

```sh
# Mac:
brew install age sops
mkdir -p ~/.config/sops/age
age-keygen -o ~/.config/sops/age/keys.txt
chmod 600 ~/.config/sops/age/keys.txt

# Copy the line that starts with "# public key:" — that's what goes in .sops.yaml.
grep "# public key:" ~/.config/sops/age/keys.txt
```

Edit `../synccenter-config/.sops.yaml`: replace the `REPLACE_ME_*` lines with your real public key (for now, one key — the QNAP can share the Mac's until you generate one there too).

Stash the **private** key somewhere durable (1Password). Without it, the sops files are scrap.

---

## Step 2 — Mac Syncthing

```sh
brew install syncthing
brew services start syncthing

# Wait ~5s for the daemon to write its config, then capture identity:
MAC_API_KEY=$(rg "<apikey>" ~/Library/Application\ Support/Syncthing/config.xml | sed -E 's|.*<apikey>([^<]+)</apikey>.*|\1|')
MAC_DEVICE_ID=$(curl -s http://127.0.0.1:8384/rest/system/status -H "X-API-Key: $MAC_API_KEY" | jq -r .myID)

echo "Mac device ID: $MAC_DEVICE_ID"
echo "Mac API key:   $MAC_API_KEY"
```

Save these values — they go into the sealed secrets file in Step 6.

> Want a folder synced to mobile too? Install `Möbius Sync` (iOS) or `Syncthing-Fork` (Android). Pair via QR code from the desktop GUI later. Mobile is best-effort; not part of the phase 1 exit criteria.

---

## Step 3 — QNAP Syncthing + rclone

The repo ships `scripts/qnap-bootstrap.sh` for the QNAP-side install. Copy it over and run it:

```sh
# Mac:
scp scripts/qnap-bootstrap.sh <qnap-host>:/share/Container/synccenter-bootstrap.sh
ssh <qnap-host> 'bash /share/Container/synccenter-bootstrap.sh'
```

The script (read it first — it's short):
- Creates `/share/Container/synccenter/{syncthing,state,rclone-config}` + `/share/Sync`
- Brings up `lscr.io/linuxserver/syncthing` and `rclone/rclone:latest rcd` via a one-shot `docker compose`
- Persists `fs.inotify.max_user_watches=524288` via `/etc/init.d/autorun.sh`
- Prints the QNAP's Syncthing device ID + API key when done

Save the QNAP device ID + API key for Step 6.

The compose file the script writes is intentionally minimal — it does NOT yet include `synccenter-api`. We'll layer that in Phase 3-deploy after the API is image-buildable. For now we just need Syncthing + rclone live on the QNAP.

---

## Step 4 — Windows Syncthing

This is the only step with no automation — SyncTrayzor v2 (the maintained fork) is a Windows installer.

```
# on Windows: download from
# https://github.com/GermanCoding/SyncTrayzor/releases — pick the latest .msi.
```

After install:
1. Let it run once so it writes its config.
2. Open the GUI → Actions → Show ID. Save the device ID.
3. Open Actions → Settings → GUI → copy the API key. Save it.

---

## Step 5 — Pair the three devices (one-time bootstrap)

Each Syncthing daemon needs to know the other two. Easiest path: GUI on Mac.

On the Mac, open http://127.0.0.1:8384:
1. **Actions → Show ID** — copy your Mac's ID.
2. **Add Remote Device** twice — once for the QNAP, once for Windows. Paste their IDs, give each a friendly name (`qnap-ts453d`, `win-desktop`). Check "introducer" on the QNAP entry only (it becomes the central hub).

On the QNAP GUI (http://<qnap-ip>:8384), accept the pairing request that pops up from the Mac. Add Windows the same way.

On Windows, accept both pairing requests when SyncTrayzor surfaces them.

**Verify**: each GUI should show all three devices as connected (green dot). If discovery struggles, paste explicit `tcp://<lan-ip>:22000` addresses into the device entries.

---

## Step 6 — Seal the secrets

Now that you have three device IDs + three API keys, encrypt them. The repo ships `scripts/seed-host-secrets.sh` to do this without leaking cleartext into shell history:

```sh
# Mac:
cd ../synccenter-config
../synccenter/scripts/seed-host-secrets.sh
```

The script prompts for each value, builds `secrets/syncthing-api-keys.enc.yaml` and `secrets/syncthing-device-ids.enc.yaml`, encrypts them via sops, and commits both. Re-run any time you rotate.

Then rename the example host manifests:

```sh
cd ../synccenter-config/hosts
mv example-mac-studio.yaml mac-studio.yaml
mv example-qnap-ts453d.yaml qnap-ts453d.yaml
# create one for Windows by copy + edit
cp mac-studio.yaml win-desktop.yaml
# edit win-desktop.yaml: name, hostname, os: windows, role: mesh-node, api_url

git add hosts/
git commit -m "phase-1: real host manifests"
```

---

## Step 7 — Google Drive remote (rclone Service Account)

1. In your Google Cloud Console: create a project (or reuse one).
2. Enable the Google Drive API.
3. IAM → Service Accounts → Create. Give it a name like `synccenter-sa`. No IAM roles needed.
4. Keys tab → Add Key → JSON. Download the file as `sa.json`.
5. **Share the target Drive folder** with the SA's email (visible on the SA's detail page). Otherwise the SA sees nothing.

Move the JSON to the QNAP and configure rclone:

```sh
# Mac:
scp sa.json <qnap-host>:/share/Container/synccenter/rclone-config/sa.json

ssh <qnap-host> '
  docker exec -i rclone-rcd rclone config create gdrive drive \
    config_is_local=false \
    service_account_file=/config/sa.json \
    root_folder_id=<DRIVE_FOLDER_ID>
'

# Smoke test:
ssh <qnap-host> 'docker exec rclone-rcd rclone lsd gdrive:'
```

The `<DRIVE_FOLDER_ID>` is the part of the share URL after `/folders/` — restricting the SA to one folder is the principle-of-least-privilege move.

> **Optional**: layer a `crypt` remote on top. See [`docs/runbooks/rclone-crypt.md`](./rclone-crypt.md) (write later — out of phase-1 scope).

---

## Step 8 — Test folder pair

Create the test folder:

```sh
# Mac:
mkdir -p ~/Sync/test
ssh <qnap-host> 'mkdir -p /share/Sync/test'

# Add the folder to all three Syncthing instances via their GUIs:
#   Folder ID: test
#   Mac path:     /Users/<you>/Sync/test
#   QNAP path:    /Sync/test  (inside the container — bind-mounted from /share/Sync/test)
#   Win path:     C:\Sync\test
# Share with all three remote devices.
```

Drop a file:

```sh
# Mac:
date > ~/Sync/test/hello.txt
ls -la ~/Sync/test
```

Within ~5 seconds, `hello.txt` should appear on the QNAP:

```sh
ssh <qnap-host> 'ls -la /share/Sync/test'
```

And — if rclone bisync is configured — within 5–15 minutes it should appear in your Drive folder. For now, just verify rclone can write to it manually:

```sh
ssh <qnap-host> 'echo phase-1-ok | docker exec -i rclone-rcd rclone rcat gdrive:phase-1-marker.txt'
```

If that lands in Drive, the rclone leg is healthy. Bisync wiring happens in Phase 3 via `POST /folders/test/bisync` against the SyncCenter API once it's deployed.

---

## Exit criteria

- [ ] All three Syncthing daemons online; mesh of three connections green
- [ ] inotify limit on QNAP shows `524288`: `ssh <qnap-host> sysctl fs.inotify.max_user_watches`
- [ ] `docker exec rclone-rcd rclone lsd gdrive:` lists the target folder without error
- [ ] `date > ~/Sync/test/hello.txt` propagates to QNAP within 30s
- [ ] `secrets/syncthing-{api-keys,device-ids}.enc.yaml` exist, sops-encrypted, committed
- [ ] `hosts/{mac-studio,qnap-ts453d,win-desktop}.yaml` exist (no `example-` prefix), committed

Tag both repos:

```sh
cd ../synccenter && git tag phase-1-complete
cd ../synccenter-config && git tag phase-1-complete
```

Phase 2 (rule engine) and Phase 3 (API + UI) are already coded; from here it's API deploy + first real folder apply.

---

## Troubleshooting

**`docker compose` not on QNAP**: install the Container Station QPKG from QTS App Center. Recent QTS versions bundle Docker; check `docker --version` before assuming.

**Syncthing on Mac won't start under `brew services`**: check `~/Library/Logs/syncthing.log`. Often a port collision with another P2P tool (e.g. Resilio).

**Devices won't pair**: confirm UDP 21027 is allowed on the LAN. Fall back to adding explicit `tcp://<lan-ip>:22000` addresses on each Remote Device entry.

**`rclone lsd gdrive:` returns 403**: the Service Account hasn't been given access to the folder. Share the folder with the SA's email address in the Drive UI.

**Bisync conflicts on first run**: do an initial seed with `rclone copy ~/Sync/test gdrive:Sync/test --transfers=4 --tpslimit=2` overnight, *then* enable bisync.
