# Sync reliability review: stale, missing, incomplete files

Reviewed September 11, 2026, approximately 16:45–16:50 America/Los_Angeles.

The primary observed failure is that the NAS, the only bridge between Omarchy and the Mac, pauses its folders before initial replication finishes. The network and services were reachable. Cloud transfers run independently and cannot establish PC freshness. Deployment drift adds a separate failure to manual cloud runs.

This review used read-only NAS/PC commands, authenticated GET requests to SyncCenter and Syncthing, cloud job logs, deployed source inspection, local source review, and local tests. No sync, resync, deletion, restart, or live configuration change was performed. Existing uncommitted work was preserved. This document complements the earlier `Sync-Flow-Review.md`; its live observations supersede that document's pre-enrollment snapshot.

## Current evidence

| Folder | Omarchy | NAS / Mac | Google Drive evidence |
|---|---|---|---|
| arik | 5,153 local files; 17,367 needed files; 53,988,454,196 bytes needed; 17,367 pull errors | NAS paused. Window 332 timed out at 15:11 PDT after 90 minutes, with 14 NAS-needed files and 439,787,798 bytes outstanding. Mac has one blocked deletion. | 04:00 scheduled run failed because its filter changed. Separate resync succeeded at 11:31 PDT. No later ordinary successful run verified. |
| dev | Zero local/global files and empty remote sequence: no initial index received | NAS paused. Last window 330 timed out at 13:00 PDT, with 51,123 needed files and 1,261,277,562 bytes outstanding. Mac scanning. | Scheduled bisync succeeded at 03:42 PDT, taking 1h42m. |
| baruchrio | Zero local/global files and empty remote sequence: no initial index received | NAS paused. Window 329 timed out despite zero local need; its connected peer was incomplete. Mac has 13 blocked deletions. | Scheduled bisync succeeded at 03:05 PDT. |
| memory-vault | 10,184 files, 6,348,158,916 bytes; zero reported need/errors | NAS active, same file/byte totals but one blocked `@Recycle` deletion. Mac zero need/errors. | Scheduled bisync succeeded at 01:37 PDT. |

These are index and log observations, not independent checksums of all files. Paused NAS folders return zero-filled status responses: those zeros do not mean empty data or successful convergence. Memory-vault file totals agree, but directory/deletion state does not fully agree.

Omarchy's Syncthing service was active with 181 GiB available. NAS storage had roughly 7.9 TiB available. Omarchy was connected to the NAS over `100.106.136.81:22000`; Mac was connected over LAN. Omarchy has no direct Mac pairing. Sample Arik errors consistently said that no connected device had the required file version. The NAS device connection is up while its Arik folder is paused, explaining why host-online status does not imply transferable files. Other blockers may emerge after that folder is resumed.

## Prioritized findings

### P1 — Bootstrap is governed by short maintenance windows

Arik, dev, and baruchrio on the NAS are scheduled every six hours with caps of 90, 60, and 45 minutes respectively. Omarchy was enrolled after the day's dev and baruchrio windows. Its Arik download was still incomplete when the replacement NAS window expired. All NAS windows were closed at inspection.

`apps/api/src/lib/sync-windows.ts` closes at the time cap and pauses the folder regardless of remaining transfer work. Its reconciler also re-pauses scheduled members opened outside a tracked window. Repeated direct unpause commands therefore do not provide a durable recovery.

Recommended correction: add an explicit initial-replication/catch-up mode with progress monitoring and a deliberate upper bound. Bring folders across sequentially, verifying the PC's received index and remaining items. Distinguish the normal maintenance schedule from enrollment. Do not mark enrollment complete at pairing or first received file.

### P1 — Deployed manual cloud runs omit the persistent bisync workdir

The deployed `bisync-service.ts` translates only manifest flags and sends no `workdir`. Production manifests do not supply one. Cron explicitly uses `/config/bisync-workdir`; the default `/root/.cache/rclone/bisync` contains only two BaruchRio dry-run listing files at inspection.

The local fix at `apps/api/src/lib/bisync-service.ts:154` derives the persistent workdir, but is absent from deployed source. Five core source files were compared with SHA-256 and all differed: sync-now, sync-windows, bisync-service, run-tracker, and app.ts. Deployed sync-now also predates the local job orchestration code.

Consequence: manual and scheduled runs do not use the same baseline state. A fresh manual run can demand initialization even after cron succeeds. This is established configuration/code divergence; no write-producing trigger was used to reproduce it.

Recommended correction: release the workdir fix through a reproducible deployment and verify the effective request against the live cron path pair, filter, remote options, and state directory before triggering anything. Preserve the existing baselines. A resync is not a substitute for correcting the request.

### P1 — Cloud success does not require mesh convergence

`apps/api/src/lib/sync-now.ts:294–322` starts cloud work after windows close unless stopped by the operator; timeout and failure do not block it. The deployed implementation has the same fall-through behavior. With realtime-only members, cloud work can start without a mesh freshness check at all. Separately, QNAP cron directly executes rclone and never checks SyncCenter's windows.

Consequence: a successful Drive run may use an incomplete NAS view. It does not mean the PC's edits reached Drive or that Drive's latest files reached the PC.

Recommended correction: define required members and record per-leg outcomes. Default whole-folder sync to blocked/partial if a required mesh leg fails. If partial transfers are desired, expose that choice explicitly and never label the overall job fully synchronized.

### P1 — The return path from Drive to PCs is missing from orchestration

Window close pauses the NAS folder. `apps/api/src/app.ts:126` handles cloud completion by recording history and emitting an event, without opening a return window or scanning the anchor. The NAS watcher is disabled on all three scheduled folders.

Consequence: Drive-originated files can reach disk on the NAS while remaining absent on the PCs until a later window, scan, and successful transfer. A pre-cloud mesh window alone cannot complete a bidirectional cycle.

Recommended correction: orchestrate mesh catch-up → cloud → NAS rescan → return mesh catch-up → verify required peers. Serialize overlapping folder/cloud operations and retain explicit partial status when any stage remains incomplete.

### P1 — “Done” ignores some pending items and treats unknown peers as complete

`apps/api/src/lib/sync-windows.ts:342–355` checks idle state, needed bytes, and needed files; it omits needed directories, symlinks, deletes, and pull errors. Failed peer accounting resets totals to zero. `peerCompletion()` excludes disconnected peers. These conditions exist in deployed source too.

The live system demonstrates why these dimensions matter: Mac Arik/BaruchRio and NAS memory-vault are idle with zero needed file bytes but have blocked deletions. A zero-byte backlog is still a backlog.

Recommended correction: require zero outstanding item counts and errors, successful peer accounting, and explicit status for required offline peers. Unknown, empty-uninitialized, paused, partially complete, and verified complete need distinct states.

### P2 — Directory ignore semantics leave service-directory deletion loops

The memory-vault rules exclude `@Recycle/`, and the NAS reports a deletion blocked by ignored contents at `@Recycle`. The compiler preserves trailing slashes. Syncthing documents that a trailing-slash directory pattern matches its contents, not the directory itself. See [Syncthing ignoring rules](https://docs.syncthing.net/users/ignoring.html).

Recommended correction: for NAS-owned service directories, review root-anchored whole-directory exclusions such as `/@Recycle` on the Syncthing side, with an explicit rclone translation. Do not globally make ignored files deletable: the Mac blockers include application-data and business folders whose ignored contents have not been classified. Inspect those contents before any cleanup. Filter changes also require a coordinated bisync baseline transition.

### P2 — Manual and scheduled conflict policy differ

`packages/apply-planner/src/schedule.ts:17–36` merges member overrides and maps `conflict.policy`. `apps/api/src/lib/bisync-service.ts:144` uses only top-level `bisync.flags`. This is also true in deployment. Production manifests choose `newer`; cron includes conflict resolution/loser flags while manual requests omit them.

Recommended correction: share one effective configuration resolver across CLI/RC execution, with parity tests for member overrides, conflicts, workdir, remote options, and filters. Test the actual request, not just a successful HTTP response.

### P2 — Cloud history and alerts miss the primary scheduler

Live `/jobs` returns no jobs; `/runs` stops on August 25, while September 11 cloud cron logs show real executions. Cron operates outside API run tracking. The alert for extended syncing requires six continuous hours in `syncing`, which scheduled windows capped at 45–90 minutes cannot satisfy. The error alert helps with reported errors but cannot detect every paused stale folder or an uninitialized peer.

Recommended correction: record every cloud attempt and exit status, including cron; expose last verified success and freshness age by folder/member; alert on repeated timeouts, unchanged backlog, missing initial indexes, and overdue success. Verify that alerts are actually routed. Alert deployment/notification delivery was not audited here.

### P2 — Deployment and operations lack a single reproducible state

Checked-in Compose mounts rclone config read-only from a different source than production, omits `SC_RCLONE_FILTERS_DIR`, and differs from live writable persistent state. `scripts/deploy-web.sh` copies the working tree and restarts the API; it does not establish that the code, config, cloud filters, and host cron were released together. Source mounting alone is not proof that the running process has loaded a particular revision.

Recommended correction: record code revision/artifact hash, configuration revision, daemon versions, effective filter hashes, mount layout, and cron hash in a deployment manifest and status endpoint. Plan restarts around active windows, then verify runtime behavior. Applying Syncthing settings is not evidence that the daemon's rclone filter or QNAP crontab was updated.

### P2 — Cloud maintenance overlaps sync scopes

Sunday 02:00 Drive-root dedupe and dev bisync start together on overlapping cloud content. Today's dev run took 1h42m, so fixed hourly staggering does not establish serialization. Use a shared lock covering overlapping remote scopes, including maintenance. This conflict is scheduled; an actual concurrent corruption event was not demonstrated.

### P2 — Generic cron generation does not quote paths

`packages/apply-planner/src/schedule.ts:38–48` concatenates paths and flags with spaces. A valid folder path containing spaces becomes multiple shell arguments; shell metacharacters have additional effects. Current production paths do not contain spaces, so this is not the present outage's cause. Render shell arguments with proper quoting and test paths with spaces/apostrophes; also account for crontab's special percent handling.

## Recommended recovery sequence

1. Capture current manifests, ignores, baselines, and per-device backlog before changes. Preserve the current working-tree edits and the successful Arik resync state.
2. Provide a tracked catch-up window or explicit bootstrap mode for the NAS folders. Start with one folder, verify Omarchy receives an index and files, then continue until required peers converge. Opening a normal short window alone may repeat the failure.
3. Resolve directory/service-path exclusions without discarding unclassified ignored contents. Watch whether NAS-needed files and error counts decrease once the window is open.
4. Reconcile deployed code and effective cloud configuration before using manual cloud sync. Confirm persistent workdir and exact path-pair/remote-option parity; do not initiate a blanket resync.
5. Run a serialized normal cloud leg only after the required mesh state is known, then scan and complete the return mesh leg.
6. Verify representative files changed on each origin—PC, NAS, Drive—including a controlled rename/delete only in an agreed disposable test directory. Compare hashes where supported and explicitly record provider-native files outside scope.
7. Replace independent cron/manual paths with one durable workflow and freshness ledger. Maintain independent recovery/retention; sync success is not a restore test.

Live operations in this sequence are recommendations, not changes made by this review. [rclone's bisync documentation](https://rclone.org/bisync/) describes baseline, filter-change, concurrency, and recovery behavior relevant to the cloud steps.

## Validation and limits

- `bun test`: 354 passed, zero failed, 30 files, 1,011 assertions.
- `bun run typecheck`: all nine workspaces passed.
- Live authenticated reads verified all four folders, NAS/Mac/Omarchy membership and connection state, recent windows, cloud log outcomes, persistent mount configuration, and deployed source divergence.
- No full file inventory/checksum comparison, Drive-native document export audit, destructive recovery experiment, cloud write, or restore test was performed.
- Passing local tests confirms existing expectations; it does not certify production convergence. Add regression scenarios for timeout gating, offline peers, deletion-only backlogs, empty initial indexes, cloud return propagation, baseline parity, and restart recovery.

Completion should mean required peers have received indexes, every relevant item/error count is clear, cloud and return legs succeeded, and the evidence is timestamped. An online host or 100% byte counter is insufficient.
