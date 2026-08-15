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

- UI: folders with a held member get a **Sync now** action; open windows draw
  a live band on the activity timeline (progress, peers caught up, close
  button), and held members read `held · scheduled` instead of `paused`.
- API: `POST /folders/<name>/sync[?host=…]`, `GET /windows`,
  `POST /windows/<id>/stop`. `GET /schedule` lists window crons under `windows`.
- CLI: `sc sync <folder> [--host <host>]`, `sc windows`.

## Deploy order

The `sync:` block is schema-validated. An API built before this feature
rejects a manifest that carries it — **deploy the new API code before pushing
manifests that use `sync:`** to the config repo the QNAP pulls.

## Rollback

Remove the `sync:` block (or set `mode: realtime`), apply the folder, then
resume it once (`POST /folders/<name>/resume`) — apply restores the watcher
settings, and the reconciler stops holding the member as soon as the mode is
realtime again.
