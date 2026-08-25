# Scheduled sync (sync windows)

Why this exists: the QNAP was pinning its CPU on continuous Syncthing work —
the fs-watcher, rescans, and delete-retry churn never let it rest. A member
that does not need instant propagation can sync in **windows** instead: the
folder stays **paused** on that host, and on a cron schedule (or on demand)
SyncCenter resumes it, lets Syncthing catch up in both directions, and pauses
it again. Between windows the host does nothing at all for that folder.

## Configure a member

Per member, in the folder manifest (`overrides.<member>.sync` — the folder-level
`sync:` block sets a default for every member):

```yaml
overrides:
  qnap-ts453d:
    sync:
      mode: scheduled        # realtime (default) | scheduled | manual
      schedule: "0 */4 * * *" # required for scheduled — 5-field cron, server-local time
      max_window_minutes: 45  # hard cap; a window still behind at the cap closes as timeout
```

- `scheduled` — windows open on the cron *and* on demand.
- `manual` — windows open only on demand (Sync now / `sc sync`).
- Apply also forces `fsWatcherEnabled: false` and `rescanIntervalS: 86400` on
  that member (a warning is emitted if the manifest asked for the watcher), so
  even a resumed-but-idle folder does not burn CPU. Re-run
  `POST /folders/<name>/apply` after changing the mode.

## What runs where

The engine lives inside the API server (`SyncWindowEngine`, started in
`index.ts`) — no crontab entries are involved. It:

1. sweeps the cron expressions every 15 s and opens windows that came due;
2. polls open windows every 2 s (`db/status`, then per-peer `db/completion`
   once the local side is caught up) and streams progress over `/events`;
3. closes a window when the folder is idle with nothing needed locally and
   every *connected* peer reports 100 % — after a 30 s minimum and two
   consecutive settled polls — or at `max_window_minutes`, whichever first;
4. re-pauses the folder on close, whatever the reason for closing;
5. reconciles every 5 min (and at boot, and after every apply): any held
   member with no open window is paused. A crash mid-window cannot leave the
   folder running.

## Driving it

- UI: folders with a held member or a cloud member get a **Sync now** action;
  open windows draw a live band on the activity timeline (progress, peers
  caught up, close button), and held members read `held · scheduled` instead
  of `paused`. **Cloud only** runs the bisync without opening a window first.
- API: `POST /folders/<name>/sync[?host=…][&cloud=false]`, `GET /windows`,
  `POST /windows/<id>/stop`. `GET /schedule` lists window crons under `windows`.
- CLI: `sc sync <folder> [--host <host>] [--no-cloud]`, `sc windows`.
  MCP: `sc_sync_folder`.

## Sync now runs every leg

A folder such as `baruchrio` has two legs: Mac ↔ NAS over Syncthing (the NAS
member held in windows) and NAS ↔ Drive over rclone bisync, which runs on the
NAS. Sync now chains them, in that order:

1. a window opens on every held member (`?host=` narrows it to one);
2. when the last of those windows closes, the API runs the bisync to every
   rclone member of the folder — the same flags and filter as the crontab leg;
3. a folder with no held member goes straight to step 2.

A window closed **by hand** (Close window / `POST /windows/<id>/stop`) cancels
the queued cloud leg — stopping is the operator saying "not now". A window
that hits its cap (`timeout`) does not: a partial catch-up is still pushed to
Drive, exactly as the nightly cron would. A cloud leg that cannot start (no
`SC_RCLONE_URL`, missing compiled filter, rcd error) lands in the ledger as an
error row and in the log, so a missing bisync is visible rather than silent.

The wait is in-memory: an API restart mid-window abandons the window and the
queued leg with it (the boot log line says how many). Pressing Sync now again
while a window is open adopts that window rather than failing, and does not
queue a second bisync.

Where to look afterwards: **Logs** shows each step as it happens (window
opened, cloud leg queued, bisync started, bisync done), **History** shows the
finished rows with their numbers.

## Deploy order

The `sync:` block is schema-validated. An API built before this feature
rejects a manifest that carries it — **deploy the new API code before pushing
manifests that use `sync:`** to the config repo the QNAP pulls.

## Rollback

Remove the `sync:` block (or set `mode: realtime`), apply the folder, then
resume it once (`POST /folders/<name>/resume`) — apply restores the watcher
settings, and the reconciler stops holding the member as soon as the mode is
realtime again.
