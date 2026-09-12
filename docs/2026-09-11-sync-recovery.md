# Sync recovery — September 11, 2026

Authorized after the reliability review. This record describes applied changes;
it does not declare the remaining initial replication complete.

## Applied

- Established a direct Mac–Omarchy Syncthing connection using verified device
  IDs, explicit Tailscale addresses, and membership in all four folders.
- Opened tracked NAS catch-up windows for dev and Arik, with a 720-minute
  recovery cap. Their six-hour maintenance schedules remain unchanged.
- Completed BaruchRio's initial file replication to Omarchy (10,727 files,
  zero needed files/errors at verification).
- Preserved copies of the 13 `.DS_Store` files blocking Mac BaruchRio
  deletions, removed only those metadata files and the resulting empty
  directories already deleted in the peer index, and verified the error count
  cleared. No business document was removed by this cleanup.
- Preserved Vaultwarden's local data and keys by adding a Syncthing-only
  `/compose/vaultwarden/data` exclusion in the Arik ruleset and on all members.
- Added the Syncthing-only `/@Recycle` exclusion for memory-vault in the
  ruleset and all members. Its file/byte totals agreed and all three devices
  reported zero outstanding items/errors afterward. Existing cloud filters
  and bisync baselines were retained.
- Deployed manual/scheduled conflict-policy parity and the persistent
  `/config/bisync-workdir` fix. Verified both Drive remotes have
  `skip_gdocs=true`. A memory-vault cloud dry run completed with zero errors;
  its reported bytes/transfers were simulated, not actual writes.
- Deployed stronger mesh completion checks, cloud blocking after failed
  windows, and tracked post-cloud return windows. Realtime return windows
  do not pause their anchors on completion.
- Routed all four QNAP cloud cron entries through the serialized tracked
  runner. Paused the two overlapping Drive dedupe cron entries. Updated the
  generated crontab renderer to use the runner as well.
- Fixed an additional controller reliability defect discovered during
  recovery: SQLite contention could terminate the process. Added a busy
  timeout, caught background poll errors, and supplied an authenticated
  window-extension endpoint to avoid out-of-process database writes.

## Recovery records

NAS backups are under
`/share/Container/synccenter/state/recovery-2026-09-11T23-51-08.145Z/`:
database snapshot, folder manifests, old ignore lists, pre-pairing mesh
configuration, deployed source archive, and the original crontab.
Treat this directory as private operational state.

The Mac metadata backup is
`/Users/ericbaruch/.local/state/synccenter-recovery/20260911-165457/`.

The initial API restart and the SQLite contention incident interrupted
earlier dev windows. Replacement windows 338 (dev) and 339 (Arik) were opened
and extended through the API. Jobs 4 and 5 track them. A real memory-vault
cloud-and-return cycle was started as job 6 / run 7. Recovery runners for dev,
Arik, and BaruchRio are queued in the API container; they wait for existing
tracked work and serialize the subsequent whole-folder cycles.

## Validation

The deployment was built and typechecked across all workspaces. Regression
coverage includes deletion-only/error-only backlogs, offline peers, failed
peer accounting, blocked cloud work, conflict-policy/member-override parity,
realtime and scheduled return windows, bounded window extension, and runner
success/failure/lock release. The existing working-tree edits were preserved.

Further verification must follow jobs through cloud and return completion,
then compare representative file hashes across Mac, NAS, PC, and Drive.
NAS/PC scans and transfers can be long because dev contains hundreds of
thousands of indexed files. Keep progress evidence separate from completion.

Final local validation for this implementation: 368 tests passed across 31
files, all nine workspace typechecks passed, dashboard production build
passed, and `git diff --check` passed. SHA-256 comparisons confirmed that the
six checked core API/runner source files on the NAS match the local release.

The sample `memory-vault/00 - Inbox/Inbox.md` has matching MD5 hashes on all
four endpoints (Mac, NAS, Omarchy, Drive). This is a sample check, not a full
inventory comparison. Real cloud run 7 was still transferring its archive
database at that check, without errors.

The task heartbeat `finish-sync-recovery` checks every ten minutes and
continues the remaining verification. It should notify only on completion,
failure, a material blocker, or required input, and pause itself once the
whole recovery is verified. It must not duplicate the queued NAS runners.

## Cloud-source stability correction (approximately 17:43 PDT)

Run 7 encountered a checksum mismatch uploading `07 - Archive/Claude History/history.sqlite`.
The run began at 17:35:27; the source database changed at 17:36:10 and was
replaced on the NAS at 17:37:17. The live source changing during upload
explains the observed mismatch. Job 6 was stopped explicitly, preserving
the bisync workdir and using normal recoverable retry behavior, not resync.

The NAS memory-vault member now uses scheduled windows at `15 */3 * * *`
with a 60-minute cap, while Mac and Omarchy remain realtime. This lets the
normal pipeline pause NAS writes during cloud transfer, then reopen it for
the return leg. Local and deployed manifests both contain this override.
The NAS member was paused for a stable-source retry started as run 8
(rclone job 1211); inspect its current job ID through the API rather than
continuing to wait on the stopped job 6. Completion remains unverified.

### Follow-up at approximately 17:59 PDT

Run 8 failed with `too many deletes`. Compared persistent old, error, and
new listings: Path1 has **zero deletions**; Path2 has exactly **one missing
file**, `07 - Archive/Claude History/history.sqlite`. An independent live
Drive listing confirmed that absence. NAS still has the 1,491,361,792-byte
file with unchanged 17:36:10 modification time. This is consistent with the
failed/canceled upload removing the old remote object.

A single-file restoration is currently running in rclone-rcd:
`rclone copyto --config /config/rclone.conf "/share/CACHEDEV1_DATA/memory-vault/07 - Archive/Claude History/history.sqlite" "gdrive-arik:/memory-vault/07 - Archive/Claude History/history.sqlite" --ignore-existing --checksum`.
Container PID at launch: 4466; local tool session: 56461. Check the live
process before retrying; do not start duplicate uploads. Completion is not
yet verified. Verify NAS and Drive MD5 after completion, then retry normal
tracked bisync and verify its return window. Do not resync or bypass the
deletion safeguard to repair this one absent file.

**Temporary policy:** memory-vault NAS is now `mode: manual`, paused, in
both local and deployed manifests. This prevents a timed window from
changing the source during the restoration. Mac and Omarchy remain realtime.
Restore the NAS scheduled override `15 */3 * * *`, cap 60 minutes, only
after restoration and the cloud-overlap guard below have been deployed.

**Additional local fixes, tested but not yet deployed:**

- Window opens refuse while the same folder has a running cloud run,
  preventing scheduled/manual overlap with uploads. Completed cloud runs
  can still open their return window. Initial reconcile rejects are caught.
- RC bisync explicitly receives the CLI default `maxDelete: 50` (percentage)
  and supports validated `--max-delete=0..100` overrides. The installed
  rclone v1.75.1 `cmd/bisync/rc.go` initializes zero-valued Options and leaves
  MaxDelete zero when omitted, whereas `cmd.go` sets the CLI default to 50.
  This explains why a single deletion stopped run 8. The current restoration
  does not rely on relaxing this limit.

Sources: [versioned RC implementation](https://github.com/rclone/rclone/blob/v1.75.1/cmd/bisync/rc.go)
and [versioned CLI defaults](https://github.com/rclone/rclone/blob/v1.75.1/cmd/bisync/cmd.go).

Validation now totals **370 passing tests, 31 files, 1,053 assertions**;
all nine workspace typechecks and diff whitespace checks passed. Deploy
these additional files only at an idle controller boundary, preserving the
active dev/Arik recovery windows and queued runners. The changed runtime
files since the last deployment are `apps/api/src/lib/sync-windows.ts`,
`apps/api/src/lib/bisync-flags.ts`, and `apps/api/src/routes/windows.ts`.

Latest PC progress: Arik 7,825 local files, 14,777 needed (46.44 GB); dev
50,054 local files, 182,639 needed (14.37 GB); both report zero errors.
NAS Arik still reports the four scan errors pending its refreshed scan.
Bulk replication and full cloud/return verification remain unfinished.

During any cloud run, keep its NAS source folder paused. If a scheduled
mesh window overlaps a long cloud transfer, inspect and prevent that overlap
before letting the source change again. Avoid controller restarts while the
current recovery windows or cloud retry are active.

## Protected Arik service paths

The resumed NAS scan identified four permission errors in host-local service
state. Metadata inspection confirmed protected PostgreSQL/OpenBao data and
Komodo key/environment directories. Added Syncthing-only whole-path
exclusions to the local/deployed Arik ruleset and all three members:

- `/backups/retired-secrets-20260907/openbao/data/raft`
- `/compose/immich/postgres`
- `/compose/komodo-periphery`
- `/komodo`

No files or permissions in these directories were changed. The cloud filter
was not changed; this extends the existing host-local Forgejo/Vaultwarden
mesh policy. Ignore lists before these additions were saved separately in
the NAS recovery directory. Recheck scan errors after the refreshed scan.

### Restoration verified at the next status check

The single-file copy process exited. Independent MD5 checks of Drive and
NAS `07 - Archive/Claude History/history.sqlite` both returned
`28369665e08153e9736116b89b783055`. The cloud restoration is verified.
A normal tracked memory-vault bisync retry was requested; inspect the latest
run/job through the API. NAS remains manual/paused during this cloud leg.
PC backlogs at this check were Arik 46.01 GB and dev 14.28 GB, still syncing.

### Heartbeat 2026-09-12 01:08 UTC

Memory-vault **job 8 completed** at 01:00:26 UTC. Real cloud run 9
completed at 00:59:48 with 33,200 bytes, two transfers, and zero errors.
Return window 340 then completed idle, zero needed bytes/files/errors,
and both configured peers complete (2/2). This verifies the cloud-and-return
cycle, alongside the restored archive's matching NAS/Drive MD5.
The NAS remains manual between windows until the pending overlap guard is
deployed; its paused status is not used as completion evidence.

PC replication continues: Arik 14,349 files / 44.94 GB needed; dev 173,103
files / 13.98 GB needed, both zero errors. Recovery windows 338/339 remain
active. The three queued runners remain waiting, without duplicate starts.
NAS scans are still running; Arik's prior four errors have not yet cleared.
A read-only ignore inspection found 11,768 raw Arik lines and roughly 20,975
expanded entries (Bun output truncation showed the totals); the generated
headers use `#`, which Syncthing treats as patterns rather than comments.
Investigate compiler output and scan cost before changing rule order or
semantics. No ignore mutations or controller restarts in this heartbeat.

### Heartbeat 2026-09-12 01:19 UTC

Normal transfer progress continues: PC Arik 14,088 files / 44.00 GB needed;
PC dev 166,830 files / 13.79 GB needed, both zero errors. Mac dev directory
backlog decreased from 689 to 431. NAS Syncthing is actively consuming
155% CPU with 4.67 GiB memory; this is not evidence of an idle process.
Windows 338/339 remain active and the same three pipeline runners remain
queued. No duplicate jobs, retries, restarts, or deployments were made.
The four NAS Arik scan errors remain unresolved pending scan completion.
Memory-vault's previously verified job 8 remains complete; no re-upload is
needed. The local compiler header defect was confirmed in header.ts and
its tests but was not changed or attributed as the cause of slow scanning.

### Heartbeat 2026-09-12 01:30 UTC

PC transfer progress remains measurable: Arik now needs 13,820 files /
43.12 GB; dev needs 160,571 files / 13.66 GB. Both still report zero errors.
All three host APIs responded. NAS dev/Arik are still scanning, with the
same four Arik scan errors; recovery windows 338/339 retain 720-minute caps.
BaruchRio and memory-vault remain idle with zero outstanding items on both
computers. Their paused NAS responses were not counted as fresh verification.
Queued runner log is unchanged. No retries, duplicate work, policy changes,
or deployment were necessary during this check.

### Heartbeat 2026-09-12 01:40 UTC

PC backlogs continue decreasing: Arik 13,536 files / 42.36 GB; dev
155,498 files / 13.51 GB, both zero errors. Mac dev has 419 outstanding
items, down from 431. Both computers have received five new memory-vault
files and agree at 10,193 local files, idle with zero outstanding items.
This is subsequent local activity, not proof those new files reached Drive.
NAS stays paused for that folder under the temporary manual policy.
NAS Arik/dev scans and four prior Arik errors persist; windows 338/339
remain running with 720-minute caps. The three existing pipeline runners
are still queued. No intervention or duplicate work was needed this check.

### Heartbeat 2026-09-12 01:51 UTC

PC transfer backlogs decreased again: Arik 13,282 files / 41.57 GB;
dev 151,275 files / 13.40 GB; both computers report zero errors. New source
activity increased the dev global index. Existing recovery windows and
queued runners remain in place.

NAS Arik scan errors increased from four to seven. The three additional
paths are retired OpenBao `data/vault.db`, `logs/audit.log`, and
`logs/audit.log.1` under `/backups/retired-secrets-20260907/openbao/`.
Read-only metadata showed all three are mode 0600, owned by UID 100.
Added these exact paths to Syncthing-only Arik extras in both local/deployed
rulesets and all three live ignore lists. Readback confirmed all entries
and no ignore parse error on each host. Prior lists were preserved in the
existing private backup directory as `arik-HOST-before-openbao-files-0151.json`.
No file contents, ownership, permissions, or cloud filters were changed.
Recheck scan errors after the updated ignore list takes effect. No controller
restart or duplicate cloud job was started.

### Heartbeat 2026-09-12 02:02 UTC

PC transfers remain active and error-free: Arik needs 13,044 files /
40.71 GB; dev needs 146,141 files / 13.28 GB. The previous check had
13,282 and 151,275 needed files respectively. Both Mac and NAS remain
scanning; the NAS still reports the seven previously identified Arik
errors, so exclusion effectiveness is not yet verified by a completed scan.
Windows 338/339 and the same three queued runners are intact. BaruchRio
and memory-vault computer endpoints remain idle with zero outstanding
items. No additional transfers, policy changes, or restarts were initiated.

### Heartbeat 2026-09-12 02:24 UTC

All seven NAS Arik errors have cleared: both folder status and the errors
endpoint now report zero errors on all three hosts. NAS Arik need fell
from 3,685 items / 439.79 MB to one file / 487,108 bytes. The folder is
still scanning, and its window correctly remains active because the PC
has not caught up. This verifies the protected-path exclusions took effect.

PC backlogs are Arik 12,633 files / 39.42 GB and dev 137,224 files /
13.06 GB, with no errors. NAS dev remains scanning with 51,793 needed files
and no errors. Existing recovery windows 338/339 and all three queued
runners remain intact. Memory-vault/BaruchRio are unchanged on computer
endpoints. No restarts, retries, or deployment were performed.

### Heartbeat 2026-09-12 02:35 UTC

All live folder status checks remain error-free. PC backlogs decreased to
Arik 12,386 files / 38.83 GB and dev 133,447 files / 12.92 GB. NAS Arik
has two small outstanding files (1.17 MB) and zero errors; NAS dev still
has 51,798 needed files while scanning. Both active recovery windows retain
their 720-minute caps and queued runners are unchanged. BaruchRio and
memory-vault remain idle on both computers; paused NAS responses are not
fresh convergence evidence. No intervention was required this check.

### Heartbeat 2026-09-12 02:46 UTC

The long dev scans have advanced: Mac is now idle with zero outstanding
items, and NAS is actively syncing. NAS dev local files increased from
186,856 to 189,691, with 48,885 files / 1.19 GB still needed and no errors.
This confirms the prior scanning phase was progressing rather than stuck.
PC needs Arik 12,235 files / 38.29 GB and dev 129,743 files / 12.83 GB;
both remain error-free. NAS Arik still scans with two outstanding files
and no errors. All recovery windows/runners are unchanged; no intervention
was needed. Memory-vault computer copies now agree at 10,198 files, but
new local activity still awaits its next NAS/cloud cycle.

### Heartbeat 2026-09-12 02:56 UTC

Transfers continue without errors: NAS dev backlog dropped to 41,227
files / 989.63 MB, while PC dev needs 126,084 files / 12.74 GB. PC Arik
needs 12,113 files / 37.77 GB. Mac dev remains idle with zero outstanding
items. NAS Arik is still scanning with two outstanding files and no errors.
Other computer folder states are unchanged and healthy. Windows 338/339
retain 720-minute caps; queued runners have not started cloud work yet.
No retries, duplicated runners, policy changes, or deployment were needed.

### Heartbeat 2026-09-12 03:07 UTC

Error-free transfers continue. NAS dev needs 34,469 files / 809.76 MB,
down from 41,227 files. PC dev needs 122,539 files / 12.67 GB; PC Arik
needs 11,958 files / 37.28 GB. NAS Arik still scans with two small files
outstanding; all reported errors remain zero. Other computer folders stay
idle with no outstanding items. Windows 338/339 and the three existing
queued runners remain active/waiting respectively. No interventions or
new jobs were necessary.

### Heartbeat 2026-09-12 03:17 UTC

NAS dev backlog continues dropping: 27,529 files / 602.87 MB remain.
PC dev needs 119,309 files / 12.58 GB; PC Arik needs 11,742 files /
36.82 GB. All reported errors are zero. NAS Arik remains scanning with
two small files outstanding; other computer folders remain idle and caught
up to their current mesh index. Windows 338/339 and existing queued runners
are unchanged. No restart, retry, policy change, or duplicate work was needed.

### Heartbeat 2026-09-12 03:28 UTC

Normal progress continues with zero reported errors. NAS dev needs 22,246
files / 492.39 MB; PC dev needs 116,038 files / 12.51 GB; PC Arik needs
11,583 files / 36.32 GB. NAS Arik is still scanning with two small files
outstanding. Other computer folders remain idle with zero outstanding
items. Both recovery windows retain their 720-minute caps, and the three
queued runners remain unchanged. No intervention was necessary.

### Heartbeat 2026-09-12 03:38 UTC

NAS Arik now reports zero outstanding items/bytes and zero errors, though
it remains scanning and its PC peer is still catching up. NAS dev needs
16,328 files / 379.26 MB. PC needs Arik 11,437 files / 35.87 GB and dev
113,097 files / 12.42 GB, all error-free. New memory-vault activity has
introduced one 890.62 MB file transfer to Omarchy; it is actively syncing,
not an error or proof of regression in the already verified cloud cycle.
The NAS memory-vault member remains held under temporary manual policy.
Both recovery windows and the same queued runners remain in place; no
additional jobs or restarts were needed.

### Heartbeat 2026-09-12 03:49 UTC

NAS dev backlog is now 8,940 files / 168.61 MB, down from 16,328 files.
PC dev needs 110,279 files / 12.33 GB; PC Arik needs 11,244 files /
35.44 GB. All reported errors remain zero. NAS Arik has two small files
outstanding while scanning. Memory-vault computers are idle again with
zero outstanding items and matching current counts; no new cloud completion
is inferred from that. Existing windows/runners remain intact. No retries,
restarts, deployment, or additional policy changes were necessary.

### Heartbeat 2026-09-12 03:59 UTC

NAS dev now needs 3,754 files / 103.49 MB (8,493 total outstanding items,
including pending deletions), down from 8,940 needed files. PC dev needs
107,290 files / 12.26 GB; PC Arik needs 11,140 files / 35.01 GB. All
reported errors remain zero. NAS Arik still scans with two small files
outstanding. The active windows retain their recovery caps, and existing
queued cloud runners remain waiting. No duplicate jobs or interventions
were needed; cloud/return verification and pending deployment remain open.

### Heartbeat 2026-09-12 04:10 UTC

NAS dev has received all currently needed file bytes (needFiles=0,
needBytes=0), but 5,843 directory/deletion or other non-file items remain.
It is correctly still syncing rather than marked complete. PC dev needs
104,673 files / 12.16 GB; PC Arik needs 10,979 files / 34.57 GB. All
reported errors remain zero. NAS Arik still scans with two small files
outstanding. Recovery windows and queued runners are unchanged; no extra
jobs, restarts, or deployment were initiated.

### Heartbeat 2026-09-12 04:20 UTC

NAS dev outstanding items decreased to 4,175 (including two small files /
27,841 bytes from ongoing source activity). PC dev needs 101,791 files /
12.10 GB; PC Arik needs 10,858 files / 34.17 GB. All reported errors remain
zero. NAS Arik is still scanning with two small outstanding files. Other
computer folders remain idle and current with their mesh index. Windows
338/339 retain 720-minute caps; the existing cloud runners are still queued.
No intervention, restart, deployment, or duplicate job was needed.

### Heartbeat 2026-09-12 04:31 UTC

PC continues catching up without errors: Arik needs 10,737 files /
33.78 GB; dev needs 99,145 files / 12.03 GB. NAS dev reports no needed
file bytes but 4,173 non-file items and is sync-preparing. NAS Arik still
scans with two small files outstanding. All reported errors remain zero.
Windows 338/339 retain 720-minute caps, other computer folders remain
idle, and the same three runners remain queued. No intervention was needed.

### Heartbeat 2026-09-12 04:41 UTC

PC progress continues: Arik needs 10,608 files / 33.39 GB and dev needs
96,514 files / 11.96 GB, with zero errors. NAS dev's remaining 4,173 items
are all deletions, unchanged since the prior check. A direct need-list
sample identifies deleted DigitalMe/brain entries; progress/queued lists
were empty while state is sync-preparing. Direct folder errors are null,
and NAS Syncthing is consuming 181% CPU / 4.43 GiB memory. No files were
manually deleted and no restart was attempted; continue watching preparation
and inspect again if this backlog persists. NAS Arik still scans with two
small files and no errors. Recovery windows/runners remain unchanged.

### Heartbeat 2026-09-12 04:52 UTC

PC backlogs continue falling: Arik 10,458 files / 32.99 GB; dev 93,873
files / 11.87 GB, with zero errors. NAS dev is syncing, with three new
small files and the same 4,173 pending deletions. Direct inspection confirms
sendreceive, ignoreDelete=false, paused=false, staggered versioning, and
no folder errors. The need-list sample is unchanged; deletions are not
being intentionally suppressed by ignoreDelete. NAS Arik remains scanning
with two small files and no errors. Both windows and queued runners remain
intact. No destructive cleanup, retries, or restarts were performed.

### Heartbeat 2026-09-12 05:03 UTC — deletion blocker investigated

NAS Arik is now idle with zero outstanding items and errors; the window
remains open for the PC. PC Arik needs 10,290 files / 32.61 GB, and PC dev
needs 91,398 files / 11.78 GB. NAS dev still has 4,173 pending deletions.

Direct Syncthing system logs now expose repeated `Failed to delete directory`
messages for dev: remote-deleted directories are not empty locally. These
messages are informational and are not reflected in folder.errors/status.
Read-only examples contain substantive files, not disposable metadata:
`web-apps/clms/docs/guides/staff/es/CLAIM_LOOKUP_SOP.md`,
`web-apps/clms/openspec/specs/developer-experience/spec.md`, and
`DigitalMe/brain/INDEX.md`. Do not delete these manually based on directory
errors. Need to compare each file's local/global Syncthing metadata and
archive any unclassified local-only content before changes.

A probable permission contributor needs follow-up: the actual Syncthing
process on NAS is UID/GID 1000 (verified /proc/26209/status), while sampled
blocking directories are admin-owned mode 0755 and files 0644. Their inode
metadata is the same through the process's filesystem root. This differs
from `docker exec syncthing id`, which reports the exec shell as root and
must not be used to infer daemon permissions. No ownership/ACL/file changes
were made. Investigate effective write access and versioning behavior before
any targeted permission repair. Existing windows and queued runners persist.

### Heartbeat 2026-09-12 05:15 UTC — scoped permission repair

PC transfers remain error-free: Arik 10,142 files / 32.19 GB; dev 88,827
files / 11.67 GB. NAS Arik remains idle/caught up; NAS dev still has
4,173 deletions. Direct db/file metadata for the three sampled documents
confirms newer global deletion vectors and older, non-deleted NAS copies.
This is not merely an assumption from their parent-directory errors.

An effective-access check as UID/GID 1000 confirmed the sampled directories
were not writable, while /share/dev/.stversions is writable. Preserved all
three sample files in private recovery `dev-permission-samples/files.tar`
and verified with tar -d. Saved original owner/mode/ACL metadata as
`dev-permission-samples/acl.before` in the same recovery directory.
Attempted per-user ACL grants, but the filesystem returned Operation not
supported for all three. Then changed ONLY the owner of these directories
to UID 1000 (ariel), preserving group and 0755 mode:

- DigitalMe/brain
- web-apps/clms/docs/guides/staff/es
- web-apps/clms/openspec/specs/developer-experience

Readback and UID 1000 test -w confirmed access. File contents and file
ownership were unchanged; no files were manually deleted. Await native
Syncthing processing of the sampled deleted files before broadening any
repair. Parent directories may separately need access for directory deletion.
Do not recursively chown the tree; map actual blockers and preserve evidence.

### Heartbeat 2026-09-12 05:27 UTC — permission repair verified and extended

All three sampled files now have localDeleted=true and globalDeleted=true;
NAS dev needDeletes dropped exactly three, from 4,173 to 4,170. This
verifies that fixing directory ownership allowed native Syncthing deletion.
PC transfer progress continues: Arik 9,965 files / 31.69 GB; dev 86,058
files / 11.61 GB, with zero errors.

Captured the full remaining need list privately as dev-deletes-0527.json:
4,170 global deletions (3,294 files and 876 directories). Enumerated only
their immediate parent directories: 899 unique directories, of which 845
were UID 0/GID 0/mode 0755 and not writable by the daemon. Others were
already UID 1000 or mode 0777 and were left unchanged. Preserved paths and
metadata as dev-directory-{paths,candidates}-0527.json and
 dev-directory-metadata-0527.txt in the original recovery directory.

Archived all 3,294 files to dev-files-0527.tar (41 MB), using a NUL-delimited
explicit file list, and verified the archive against live contents with
tar -d (exit 0). Then prechecked all 845 candidate directories were still
non-symlink UID 0/GID 0/mode 0755, changed ONLY owner to UID 1000, and
verified every result remained GID 0/mode 0755. No file ownership or file
contents were changed and no manual deletion was performed. This is an
explicit list derived from pending deletions, not recursive chown.

Let Syncthing process these through its existing staggered versioning;
verify the deletion backlog decreases on the next check. Active recovery
windows, queued runners, cloud baselines, and pending deployment remain
unchanged. Private backup records allow restoring original ownership.

### Heartbeat 2026-09-12 05:56 UTC — remaining local leftovers

The permission repair reduced NAS dev needDeletes from 4,170 to 44.
All 44 remaining entries are globally deleted directories, captured in
private dev-deletes-0556.json. They collapse to 31 non-overlapping roots.
Samples contain ignored conflict copies, ClaudeClaw dist output, its local
SQLite database plus WAL/SHM, and CLMS build/test remnants. These are not
additional permission failures. Do not discard the database or conflict
copies as junk. Inventory roots and size report are available through
/tmp/sc-dev-leftovers.py and /tmp/sc-dev-leftover-roots.json on the Mac.

Before moving leftovers to recovery storage, inspect whether any process
is using them and preserve an archive verified against contents. A read-only
lsof inspection was started through /tmp/sc-dev-openfiles.py (local tool
session 74326); completion not yet observed at this write. No leftover
files were moved/deleted, and no exclusions were added for source folders.
PC transfer progress continues: Arik 9,610 files / 30.66 GB, dev 79,782
files / 11.38 GB, zero errors. Existing windows and queues remain intact.

The lsof inspection completed successfully with zero open-file matches for
all 31 leftover roots (exit 0). Archived those explicit roots to private
`dev-leftovers-0556.tar` and verified against source with tar -d. Moved the
31 roots into `dev-leftovers-preserved/` inside the existing recovery
backup directory, preserving relative paths, then verified the moved tree
against the same archive (tar -d exit 0). The old database, WAL/SHM,
conflict copies, and build/test leftovers are retained in both archive
and extracted form. No blanket deletion or source-folder exclusion was
used. Await native Syncthing reconciliation of the 44 obsolete directories.

Immediately after the move, NAS needDeletes fell to 16 and it started
scanning. Those 16 errors explicitly say `file modified but not rescanned;
will try again later`. They correspond to the moved directory paths and
are awaiting the scan, rather than permissions or lost contents. Mac is
also scanning the resulting index updates. Recheck after scan completion;
do not repeat the move or restore obsolete paths into the active tree.

### Heartbeat 2026-09-12 06:11 UTC — NAS cleanup verified complete

NAS dev is now idle with zero outstanding files, bytes, deletions, and
errors. NAS Arik is also idle with zero outstanding items/errors. This
verifies the scoped permission repair and preservation of leftover content
resolved the NAS backlog. Neither recovery window is complete yet because
the PC is still catching up.

PC Arik needs 9,393 files / 30.11 GB; PC dev needs 76,178 files / 11.27 GB,
with zero errors. One initial Mac dev API read timed out; immediate bounded
retry succeeded, showing scanning with 70 outstanding items and no errors.
Other computer folders remain idle and current within their mesh. Existing
windows 338/339 and three queued runners remain intact. Pending deployment
and final cloud/return verification remain open; no duplicate work started.

### Heartbeat 2026-09-12 06:24 UTC

NAS Arik/dev remain idle with zero outstanding items and errors. PC
transfers continue: Arik needs 9,285 files / 29.74 GB; dev needs 73,600
files / 11.22 GB, with zero errors. Mac dev is scanning with 70 pending
deletions, unchanged since the last retry; monitor these after its scan.
All host reads succeeded this time. Other computer folders remain idle.
Windows 338/339 retain their 720-minute caps and the three existing runners
remain queued; no additional work or restart was initiated.
