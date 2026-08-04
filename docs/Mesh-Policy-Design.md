# Mesh Policy Design — master policies, job templates, delegation, backup

Status: **design + partial implementation** (2026-08-03). What exists today is
marked ✅; everything else is a committed direction, not yet code.

## 1. The mesh

Every member is a node; engines are an implementation detail per node:

| Node | Engine | Role | Status |
|---|---|---|---|
| mac-studio | Syncthing (brew) | mesh-node | ✅ live |
| qnap-ts453d | Syncthing (docker) + rclone rcd | **cloud-edge anchor** | ✅ live |
| win-desktop | Syncthing (nssm) | mesh-node | ✅ enrolled |
| gdrive (eric, SyncCenter-rooted) | rclone | cloud member | ✅ live |
| gdrive-arik (eric, My Drive root) | rclone | cloud member | ✅ live |
| gdrive-baruchriollc | rclone | cloud member | ⏳ OAuth pending |
| proxmox-01 | Syncthing (LXC) | mesh-node / backup brain | planned |
| s3 / b2 bucket | rclone | **backup** member | planned |
| usb-media (rotating disks) | rclone local + hotplug | **backup** member | planned |

Live nodes exchange in real time over Syncthing; cloud/backup members hang off
the anchor via scheduled rclone. A folder's `paths:` decides who participates —
that is the whole membership model, and it already scales to n nodes.

## 2. Master policies (design)

A **policy** is a named data-class contract; folders reference one and may
override details. Policies live in `synccenter-config/policies/*.yaml`:

```yaml
# policies/dev-tree.yaml (sketch — schema not yet enforced)
name: dev-tree
rules:
  respect_gitignore: true        # NON-NEGOTIABLE DEFAULT for every policy
  base: [ruleset://hbs-parity]
conflict: newer
versioning: { type: staggered, params: { maxAge: 30d } }
placement:
  private: allow                 # syncthing mesh members
  cloud_plaintext: allow         # per-class; `records`/`media` also allow
  cloud_encrypted: allow
backup:
  require: [cloud, offsite]      # jobs below must satisfy this
secrets:
  handling: harvest              # see §4: never plaintext off-box, never dropped
```

Standing principles (Eric, 2026-08-03):

1. **Respect `.gitignore` and alike on every leg, always.** Mechanism today ✅:
   `scripts/generate-gitignore-tree.ts` aggregates every nested `.gitignore`
   (576 repos under /share/Arik), re-anchors patterns to the folder root, and
   rulesets import the result — so Syncthing and rclone legs match by
   construction. Roadmap: run the scan at apply-time on the anchor
   (`rules.gitignore_scan: auto`) instead of a committed snapshot. "And alike"
   extends the same loader to `.ignore` / `.rcloneignore` / `.stignore` files
   found in the tree.
2. **Gitignored ≠ worthless.** Secrets are gitignored *because they are
   valuable*. They still get sync/backup treatment — see §4.

## 3. Jobs are templates; triggers are delegation

A **job template** is a parameterized action; an **instance** binds it to a
folder × member. Any instance can be fired by any trigger — the template
doesn't know or care who invoked it:

| Template | Action | Today |
|---|---|---|
| `bisync-leg` | rclone bisync folder⇄cloud member with compiled filters | ✅ planner renders cron lines |
| `apply` | compile rules, push ignores, rescan | ✅ API/CLI/MCP |
| `secrets-harvest` | seal gitignored secrets into an age bundle inside the tree | ✅ `scripts/secrets-harvest.ts` |
| `backup-cloud` | rclone `sync --backup-dir` (or restic) to S3/B2, versioned | planned |
| `usb-clone` | mirror folder(s) to attached disk, verify, eject | planned |
| `verify` | checksum spot-audit between two members | planned |

Delegation matrix — who may pull the trigger:

| Trigger | Mechanism | Exists |
|---|---|---|
| Manual | `sc apply / sc bisync trigger / bun scripts/...` + web UI | ✅ |
| Cron | `sc schedule render` → /etc/config/crontab on the anchor | ✅ |
| AI | MCP tools (`sc_apply`, `sc_trigger_bisync`, …) — mutating calls require `confirm: true` | ✅ |
| Event | Syncthing event stream, QNAP USB-hotplug autorun, webhook | planned |

The delegation rule: **policies say what must be true; templates say how; a
trigger only picks when.** An AI trigger gets no more authority than cron — it
fires existing instances, it does not invent scope.

## 4. Secrets: excluded from sync legs, never from protection

Sync rulesets exclude hidden + gitignored files, so raw `.env` / keys never ride
a leg — correct for cloud (plaintext Drive is forbidden) but it would orphan
the only copy. The compensating job ✅:

- `scripts/secrets-harvest.ts` scans a tree for secret-shaped files
  (`.env*`, `*.pem/key/p12`, `id_*`, service-account/credentials JSON, …),
  seals them with the repo's SOPS **age** recipient into
  `<root>/backups/secrets-vault/<host>-secrets-<ts>.tar.age`, retention 30.
- The bundle sits *inside* the synced tree → mesh replicates it to the NAS and
  bisync carries it to Drive. Three copies, all encrypted, zero plaintext
  off-box. Restore: `age -d -i keys.txt bundle | tar -x`.
- Run it manually, by cron (`15 2 * * *` suggested on the Mac), or as an MCP
  job. Roadmap: per-member ruleset overlays (`overrides.<member>.ruleset`) so
  private mesh legs may carry raw secrets while cloud legs still exclude them.

## 5. Backup ≠ sync (3-2-1)

Sync replicates *current state* — it happily replicates a mistake. Backups add
history and an air gap:

- **Today after cutover**: 3 copies of each tree (Mac ⇄ NAS ⇄ Drive), 30-day
  staggered versioning on mesh nodes, RAID on the NAS, encrypted secret
  bundles. Weak spots: no immutable/offline copy, Drive-native gdocs exist
  only in Google.
- **S3/B2 member** (next): a bucket is just another rclone remote on the
  anchor — `backup-cloud` template runs nightly
  `rclone sync --backup-dir=history/<date>` (or restic for dedup+crypto) using
  the *same compiled filters*. Versioned bucket + object-lock gives the
  immutable copy.
- **Physical media** (next): USB dock on the QNAP; hotplug autorun fires the
  `usb-clone` template → mirror + verify + eject, disks rotated offsite.
  rclone `crypt` wrapper if a disk leaves the house.
- **Google-native files**: `*.gsheet/gdoc` are pointer files; real content
  lives only in Google. Periodic Takeout export into the NAS tree is the
  planned cover.

## 6. Rollout

1. ✅ Folders `arik` + `baruchrio` span Mac + NAS + Drive with one ruleset each
   (replaces HBS3 jobs *and* FreeFileSync Arik/BaruchRio.ffs_gui).
2. BaruchRioLLC OAuth → seal token → render rclone.conf (unblocks its Drive leg).
3. Cutover: disable HBS3 jobs + stop FreeFileSync/RealTimeSync use; `sc apply`;
   seed each bisync with `--resync`. Expect a one-time union merge Mac∪NAS
   (Mac-only dirs like family-media/immich-data will flow NAS→Drive).
4. win-desktop joins folders that make sense (add `win-desktop:` paths).
5. Policy schema + planner resolution (`policy:` key on folders).
6. S3/B2 backup member + `backup-cloud` template; USB `usb-clone` template.
7. proxmox-01 node; apply-time gitignore scanning; per-member ruleset overlays.
