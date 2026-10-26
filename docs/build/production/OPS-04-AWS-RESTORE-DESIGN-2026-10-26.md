# PROD-OPS-04: live AWS restore design

Status: proposal, 26 October 2026. Design only. Nothing here calls a cloud API, and nothing here adds harness code.
Base: `origin/codex/production-2026-10-02` (ffec2cbb). Companion docs: `AWS-PRODUCT-HOOK-DESIGN-2026-10-25.md` (the
harness pattern this follows), `verify/PROD-OPS-04.md` (the local rehearsal handoff).

## Acceptance

Ledger (`docs/build/production/ledger.json`, PROD-OPS-04): "Restore product/platform/agent/hosted/source stores,
Temporal/artifacts/customer state and keys; consumed approvals/mutations cannot resurrect, controlled epoch
reconciliation/reopen required."

No part of this is proven live today. The local rehearsal in `verify/PROD-OPS-04.md` is recorded there as not run.

## 1. What exists

There are two restore paths. They use different stores and different seals. Only the hosted path can write to S3.

### A. Hosted store (SQLite by default, `src/lib/hosted/backup/`)

- Backup: `createBackup` (`create.ts:85`) snapshots `control.sqlite` and each app's `data.sqlite` through the online
  backup API (`create.ts:104`, `snapshotSqlite`), packs them, seals with `ZENITH_BACKUP_KEY` (`create.ts:135`, AES-256-GCM
  in `crypto.ts`), and writes `backups/<id>.zbk` to the configured target (`targets.ts:439`). Artifact bytes are excluded
  unless `--include-artifacts`. The default hosted store is SQLite (`src/lib/hosted/config.ts:40`).
- Target: `selectedBackupTarget` (`targets.ts:361`). S3 region now comes from `ZENITH_BACKUP_S3_REGION`, then `AWS_REGION`,
  then `AWS_DEFAULT_REGION` (this PR, `targets.ts:424`, `targets.ts:398` refuses when none is set and no endpoint is named).
- Restore: `restoreBackup` (`restore.ts:138`) reads the object by key from the same target (`restore.ts:152`), unseals,
  unpacks, writes into an empty directory, then reconciles the off-host revocation ledger `ledger/revocations.jsonl`
  (`restore.ts:287`, `restore.ts:313`). Revocations newer than the snapshot are re-applied (`restore.ts:345`). If the ledger
  cannot be read far enough, every grant moves to `needs_reapproval` (`restore.ts:395`).
- Reopen is a separate, deliberate step (`reopen.ts:1-20`). Held grants need `acknowledgeReapproval: true` (`reopen.ts:42`).
- Revocations reach the ledger through an outbox handler (`src/lib/hosted/usage/index.ts:430-439`), so a live revocation
  produces a real S3 append.

Gaps in this path:

- Backup reads SQLite only: `backupAuthority` opens `new DatabaseSync(source.path)` (`src/lib/hosted/authority/lifecycle.ts:218`).
  A hosted store on Postgres has no backup path here.
- Restore has no Postgres authority (`restore.ts` header, TODO(ceiling)).
- This store holds grants, sessions and revocations. It does not hold platform approvals or operations, so it cannot
  prove the approval clause on its own.

### B. Platform Postgres (`src/lib/ops/recovery/`, `scripts/ops/recovery.ts`, `src/lib/controlplane/recovery/`)

- Backup: `captureBackup` (`src/lib/ops/recovery/backup.ts:87`) takes one `pg_dump` under an exported snapshot, with row
  counts, schema version and recovery epoch recorded in the manifest. Each file gets a SHA-256 (`manifest.ts`). The
  manifest "seal" is a digest only (`manifest.ts:91`, `sealManifest`), not encryption. Output is a local directory
  (`--out DIR`). Nothing in `src/lib/ops/recovery/` reads or writes S3. The hosted component is the sealed ZBK1 bundle
  handed off from path A (`backup.ts:159`). For a Postgres hosted store, the hosted schema is inside the same dump (`backup.ts`, `covered("hosted", ...)`).
- Restore: `runRestore` (`src/lib/ops/recovery/restore.ts:146`): verify, keys gate (`restore.ts:206`), empty-target gate
  (`restore.ts:209-225`), atomic `pg_restore`, forward migrate, count check (`restore.ts:247-249`), epoch bump
  (`restore.ts:258`, `bumpRecoveryEpoch` in `src/lib/controlplane/recovery/index.ts:165`), continuation measurement (`restore.ts:265`).
- The epoch fence is in the schema and repos: migration `0046_recovery_epochs.ts` (on this base; the verify handoff says
  44, from another branch). Stale operations are refused at claim (`src/lib/controlplane/db/repos/operations.ts:465-479`,
  `reason: recovery_epoch_stale`). Stale approvals are refused (`repos/approvals.ts:127-139`). Only current-epoch approvals
  count (`repos/approval-core.ts:43`, `:58`). The outbox claims only current-epoch intents (`src/lib/controlplane/outbox/index.ts:150`, `:182`, `:203`, `:230`).
- Operator continuation: `listRecoveryItems` (`controlplane/recovery/index.ts:385`), `decideItem` (`:414`), CLI
  `ops:recovery continue`, API `GET /api/platform/v1/recovery` and `POST .../items/[id]/decide`
  (`src/app/api/platform/v1/recovery/`).
- Local rehearsal of the whole sequence: `scripts/release/drivers/restore.ts` (`browser-approved-snapshot`,
  `post-snapshot-consumption`, `damaged-backup-refused`, `missing-keys-refused`, `nonempty-target-refused`,
  `operator-cli-route`). It is the closest existing pattern. It has not been run.

Gaps in this path:

- No S3 writer or reader (G1 below).
- The dump is not encrypted with `ZENITH_BACKUP_KEY`. Sealed columns stay sealed, but the rest of the dump (operations,
  approvals, runner rows, hosted schema) is plaintext in the directory.
- Epoch collision: without `--observed-epoch` the new epoch is one past the restored database's own, so two restores
  from one backup can reuse an epoch number (`verify/PROD-OPS-04.md`, known gap 3).
- Post-snapshot provider effects are not visible to the restore (`verify/PROD-OPS-04.md`, known gap 2). Reconciliation with
  the provider is a human runbook step.

## 2. Product gaps for a live run

| # | Gap | Where | Blocks |
| --- | --- | --- | --- |
| G1 | Platform dump has no seal under `ZENITH_BACKUP_KEY` and no S3 path. Fix: pack the dump directory with `packBundle` (`src/lib/hosted/backup/bundle.ts`), seal with `seal()` (`crypto.ts`), put and get through the target. Estimated about 150 lines plus tests. | `src/lib/ops/recovery/backup.ts`, `restore.ts` | Phase B |
| G2 | Hosted backup and restore are SQLite-only. Default stack is SQLite, so this blocks nothing today. | `lifecycle.ts:218`, `restore.ts` header | Only if the stack moves hosted to Postgres |
| G3 | No live approval or mutation drive for the platform path. The operated driver (`scripts/release/drivers/operated.ts`, `approveOperation`) runs locally only and is not on the live `ProductScenarioPort`. | `contracts.ts:79-87` (port, no OPS-04 implementation) | Phase B |
| G4 | No live scenario id for OPS-04. `SCENARIOS` lists only `fixtures`, `retention-s3`, `rel-04`. | `scripts/acceptance/live/contracts.ts:5` | Both phases |
| G5 | Temporal restore needs the Temporal CLI on the runner (`--terminate-temporal`, `required: true` in `drivers/restore.ts`). Whether the lean stack provides it is unverified. | `src/lib/ops/recovery/process.ts`, runner image | Phase B |
| G6 | Revocation ledger append runs through the outbox worker. The live proof needs that worker running on the stack. | `src/lib/hosted/usage/index.ts:371`, `:430` | Phase A |
| G7 | Artifact bytes are not restored by default (index only). The live run proves the index, not the bytes. | `backup.ts` artifacts component | Accepted limit |

## 3. Proposed live scenario `restore-s3`

Phase A is the cheapest honest step and uses only code that exists after this PR. It proves hosted grants and revocations.
Phase B proves approvals, mutations and epoch reopen. The acceptance clause is not closed until Phase B passes.

### Phase A: hosted store, sealed, to S3 and back

1. Preflight: `hosted:backup-live-check` against the run bucket in `ap-south-1` (`scripts/hosted/backup-live-check.ts`, now
   region-aware). This answers whether the endpoint honours `If-Match`/`If-None-Match`.
2. Generate a per-run `ZENITH_BACKUP_KEY` (32 random bytes, in process only). Pass it to host child processes only, as
   `childEnv` does in `scripts/acceptance/live/product/retention-s3.ts:69-80`.
3. Seed through the product: one workspace, one app, one active grant G1.
4. Snapshot: `createBackup()` with `ZENITH_BACKUP_TARGET=s3`, `ZENITH_BACKUP_S3_BUCKET=<run bucket>`,
   `ZENITH_BACKUP_S3_REGION=ap-south-1`. Readback: `HeadObject` on `backups/<id>.zbk` with checksum mode, compared with
   the recorded manifest `digest` and `byteSize`.
5. After the snapshot, revoke G1 through the product. Readback: `GetObject` on `ledger/revocations.jsonl` shows a line with
   `seq` greater than the manifest's `revocationSeq`.
6. Destroy: stop hosted services and move `ZENITH_DATA` aside. Start on a fresh, empty data directory on the same runner.
7. Restore: `restoreBackup` with the object key, reading from S3. Readbacks in the restored `control.sqlite`: G1 is not
   active; `reconciliation.evidenceComplete` is true; `revocationsApplied >= 1`.
8. Negative probes: a wrong `ZENITH_BACKUP_KEY` is refused at unseal; a restore into a non-empty directory is refused.
9. Reopen: `reopenApp` without acknowledgement is refused while grants are held; with acknowledgement it passes only when
   every check passes. Recorded as the operator step.

### Phase B: platform Postgres, epoch fence and reopen

Needs G1, G3, G4 and G5 first.

1. Stack up on the runner with the lean profile (`scripts/acceptance/default-stack/up.mjs`), platform Postgres, no RDS.
2. Through the browser path (same-origin, no bearer token, TOTP step-up, automated test approver per decision D1 in
   `AWS-PRODUCT-HOOK-DESIGN-2026-10-25.md`): propose and approve operation O1, let it succeed. Propose and approve
   operation O2 and leave it approved but not yet run.
3. Snapshot: `captureBackup` to a scratch directory, `verifyBackupDirectory`, pack and seal (G1), upload with SHA-256
   checksum to `backups/<runId>/` in the run bucket. Readback: `HeadObject` checksum equals the recorded file digest.
4. After the snapshot: approve and consume an approval for O1 that changes state (an `external_effects` row and, if the
   product path allows it, one provider object in the run bucket). The lost timeline now holds the consumption.
5. Destroy and start clean: create a fresh database (the name and owner-comment pattern from `drivers/restore.ts`), start
   API and worker against it.
6. Download the sealed object to a fresh scratch directory, unseal with the run key, `verifyBackupDirectory`.
7. Refusal probes first: damaged dump refused (`verify`), missing key id refused (`keys`), non-empty target refused (`empty`).
8. Restore with `--observed-epoch <manifest.platform.recoveryEpoch>` (`scripts/ops/recovery.ts restore`).
9. Independent readbacks by SQL on the restored database, not through the product:
   - `platform.recovery_epochs` maximum equals observed epoch plus 1.
   - O1's consumed approval is not counted: `count(*)` of unconsumed current-epoch approvals for O1 is 0.
   - O1 and O2 are not `running` or `queued`. Their rows have `recovery_epoch` below the current epoch.
   - `platform.recovery_items` has one row per in-flight operation and per pending effect, with the decisions allowed.
10. Product checks through the API: a claim or approval on O1 is refused with `recovery_epoch_stale`. O2 cannot be
    approved or run until a decision exists.
11. Reopen: a browser decision `resume` on O2 starts a fresh approval round (`approval_round + 1`). The old approval still
    does not count. A decision `abandon` on a second item cancels it. `keep_uncertain` on the effect.
12. Cleanup: drop the restored database (owner-comment check), delete `backups/<runId>/` objects through a bounded drain,
    delete the run bucket, confirm absence.

## 4. Harness changes

Owned by another stream, so none of these are edited in this PR:

- `scripts/acceptance/live/contracts.ts:5`: add `restore-s3` to `SCENARIOS`.
- `scripts/acceptance/live/plan.ts:8-10`: add the scenario, its family and its scope (`PROD-OPS-04`).
- `scripts/acceptance/live/plan.ts:84-94` pattern: add a bounded drain for `backups/` and `ledger/` before `DeleteBucket`,
  as the retention block does for `retention/`.
- `plan.ts` `s3Actions` map (`plan.ts:~63`): map `HeadObject` to `s3:GetObject`.
- `plan.ts:159` estimate: add a `restore-s3` estimate.

New file, allowed in a later PR: `scripts/acceptance/live/product/restore-s3.ts`, modelled on `retention-s3.ts`. It uses the
same seams (`sql`, `run`), host child processes for the product, and the guarded `call` for S3 readbacks.

Planned S3 calls. Product writes (PutObject, conditional ledger appends, GetObject on restore) run inside host child
processes with the session role, so they are bounded by IAM, not by the guard, as design doc section 4 describes.

| Call | Purpose | Max calls |
| --- | --- | --- |
| `ListObjectsV2` prefix `backups/` | Exactly one backup object is listed | 2 |
| `HeadObject` `backups/<id>.zbk` (checksum mode) | Size and SHA-256 readback | 2 |
| `GetObject` `ledger/revocations.jsonl` | Post-snapshot revocation line present | 2 |
| `HeadObject` `backups/<runId>/...` (Phase B) | Checksum readback of each dump file | 4 |
| `ListObjectsV2` + `DeleteObjects` `backups/`, `ledger/` | Bounded cleanup drain | 6 and 5 |
| existing `CreateBucket`, tagging, public-access block, encryption, `HeadBucket`, `DeleteBucket` | Unchanged from the fixtures plan | per plan |

## 5. IAM additions

For `ZenithLiveAcceptance` in `deploy/live-sandbox/aws/main.tf`, next to the existing statements at lines 121-123, scoped to
run buckets only:

- `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` on `arn:aws:s3:::zenith-zlive-*-<account>/backups/*`.
- `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` on `arn:aws:s3:::zenith-zlive-*-<account>/ledger/*`. Needed only for
  Phase A, because the ledger is appended with conditional writes.
- No new action beyond object operations. `ListBucket` is already granted (`main.tf:121`). `HeadObject` uses `s3:GetObject`.

Prefix correction: the request said `backup/`. The code writes `backups/<id>.zbk` (`targets.ts:439`) and the ledger at
`ledger/revocations.jsonl` (`targets.ts:442`). This design uses those real prefixes. Applying the IAM change needs owner
decision D5, and the owner applies it through `main.tf`. This PR does not edit `main.tf`.

## 6. Runtime and cost estimate

- S3: about 50 requests and a dump of a few megabytes at most. Cost is cents, with the same 0.25 USD cleanup reserve as
  `retention-s3` (`plan.ts:159`). No RDS, ECS, DNS, Lambda or IAM fixtures. Owner must validate regional rates.
- Time: stack start on the runner (lean profile not yet measured; the default profile took 682 s on a hosted runner,
  `AWS-PRODUCT-HOOK-DESIGN-2026-10-25.md` section 1). Phase A about 15-25 minutes after start. Phase B about 20-30 minutes more.
- The AWS session is requested after stack start, as the design doc prescribes, and it is one hour. Job timeout 90 minutes.
  The AWS-touching part must fit inside the session.

## 7. Risks

1. G1 is the critical path. Without the seal and the S3 path, Phase B cannot claim "sealed with `ZENITH_BACKUP_KEY`".
2. The restore key is per run. Losing it makes the backup unreadable, and the product says so (`crypto.ts`, key message).
   The harness must keep it in memory only and never log it.
3. Epoch collision if `--observed-epoch` is omitted (see section 1B).
4. Post-snapshot provider effects are invisible to the database restore. The scenario proves only the objects it creates.
5. The ledger-unreadable path closes all grants by design (`restore.ts:395`). The scenario must test that branch as well,
   or it proves only the easy path.
6. Runner must have pg_dump and pg_restore at the server's major version (`drivers/restore.ts`, `matching-pg-client-major`).
7. Restore drops the public schema on the target (`drivers/restore.ts`). Only a database this run created may be the target.
8. Automated test approver (decision D1): evidence must say so.
9. Conditional writes: the ledger depends on `If-Match`. AWS honours it. The probe in step A1 is the check.
10. Region: `ap-south-1` matches the commercial-region regex in `plan.ts:~60`.

## 8. What stays unprovable live

- S3 durability, versioning and object lock. The scenario reads back its own objects. It does not test loss.
- Customer OpenTofu state and customer cloud resources. They are referenced only and never copied.
- Artifact bytes (index only by default).
- Provider truth after post-snapshot mutations. The product marks effects uncertain. A person decides.
- Postgres-backed hosted store (no backup path).
- Replay inside the 10-minute signed-request nonce window (`verify/PROD-OPS-04.md`, known gap 4).
- Temporal cluster semantics beyond what the CLI reports. A dev server or Temporal Cloud behaves differently.
- RPO and RTO: targets are provisional (OPS-01 not in this base; `src/lib/ops/recovery/report.ts`).
- Supabase Auth prerequisites and role grants (`drivers/restore.ts` uses `--no-privileges`).
- "Cannot resurrect" for objects the scenario does not touch. The claim is limited to O1, O2, G1 and their effects.
- Approvals made by a person. In-product approvals use the CI test approver (D1).

## 9. Decisions needed

- D5: accept the `ZenithLiveAcceptance` object-prefix IAM in section 5 (`backups/*`, and `ledger/*` for Phase A).
- D6: accept Phase A first, with Phase B blocked on G1, G3, G4 and G5.
- D7: confirm the lean stack's hosted store (SQLite) and whether Temporal CLI is on the runner image (G5).
