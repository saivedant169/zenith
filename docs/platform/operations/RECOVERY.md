# Backup, recovery and rotation

What to back up, in what order to bring things back, what the platform does with
an operation when something crashes, how leases and fence tokens behave, and how
to rotate keys and migrate the schema. For where each component runs, see
[DEPLOYING.md](DEPLOYING.md).

Written against branch `prod/compose`, based on merged Wave 5 source at `443bfeaf537dd5d5324d33c84fc544ede0baa632` (2026-10-08).

**Read this first.** The recovery machinery in the store (leases, fence tokens,
`uncertain`, the reconciler) is built and was exercised against a real PostgreSQL
(see [What was rehearsed](#8-what-was-rehearsed)). The capability broker now opens
the platform store behind `/api/platform/v1`, so proposals, approvals and
cancellations use the ledger. The worker registers composed execution activities;
product deploys and MCP v3 start workflows. Environment reconciliation and runner
job reaping are driven by ticks (`src/lib/platform/app.ts`,
`src/lib/server/cron.ts`, `.github/workflows/tick.yml`). The standalone ledger
backstop `reconcileOperations` runs in the leased housekeeping pass, called by
the jobs tick with `?housekeeping=1` and the in-process slow scheduler
(`src/lib/platform/housekeeping.ts`). This page describes the
contract the code enforces, plus the operator steps around it; it is not a record of
a production recovery. The places where a statement is reasoning from the code
rather than something observed are marked **reasoned**.

## 1. What state exists, and what can rebuild it

| State | Where it lives | Authoritative for | Rebuildable? | How it is backed up |
|---|---|---|---|---|
| **Platform store** | Postgres schema `platform` (PGlite locally) | Operations, approvals, policy decisions, capability grants, leases and fence counters, events, evidence, environment autonomy, workspace policy, provider connections, resources, runners, machines, incidents, cost estimates, reconciliation schedules | **No** for the ledger tables (operations, approvals, decisions, grants, events, evidence, settings, connections). Observations, runtime state, drift reports and reconciliation schedules are re-observable or re-registered. | `pg_dump --schema=platform`, or your provider's backups / point-in-time recovery (section 2.1) |
| **Product store** | `<ZENITH_DATA>` (file) or Supabase Postgres via PostgREST | Workspaces, projects, revisions, deployments, the product's audit log | No | Out of scope here; see [RUNNING.md](../../RUNNING.md) and [HOSTED-POSTGRES.md](../../HOSTED-POSTGRES.md) |
| **Product secret store** | `<ZENITH_DATA>/secrets.json`, encrypted under `ZENITH_SECRET_KEY` | Secret values behind `vault:` references | **No, and the key cannot be recovered**: values written under a lost key cannot be read back; there is no re-wrap tool ([LIMITATIONS.md](../../LIMITATIONS.md#secrets)) | Back up the file and the key **separately** |
| **Temporal history** | Temporal Cloud or your cluster | In-flight workflow state: ids, digests, counts, redacted messages | No, but nothing permanent lives only here; the ledger holds the operation record | Temporal's own; Cloud retention is a namespace setting (section 2.3) |
| **Customer OpenTofu state** | S3 (AWS or OCI-compatible), GCS or Azure Blob, selected from connection identifiers | What OpenTofu applied | No | Customer-managed versioning/backups; no live backend restore is verified (section 2.4 and DEPLOYING.md section 2.14) |
| **Signing keys and the result-sealing key** | Secret manager or KMS | Zenith's OIDC identity, grant signatures, and the key that seals runner and `zenithd` results at rest (`ZENITH_RUNNER_RESULT_KEY`, or derived from the control signing key) | Replaceable, not recoverable (section 6); results sealed under a lost sealing key are unreadable | Your secret manager's backup; KMS keys have their own deletion protection |
| **Policy bundle, price catalog** | The repository (`policy/dist`, `src/lib/placement/catalog`) | Rules and prices | Yes: `npm run policy:check` reproduces the bundle | Git |
| **Execution worker** | Process plus private binary plans in `ZENITH_WORKER_PLAN_DIR` | Local plan artifacts before apply | Process yes; artifact availability across replicas is not verified | Keep plan storage private; plans may contain secrets. Do not put them in logs or model-visible backups. |
| **Cloud credentials** | Nowhere: never stored | | Not applicable: minted per operation inside `withSession` | None |

The store holds references (`vault:...`, ARNs, secret names), digests and
redacted summaries by design, and refuses literal secret shapes at write time
(`src/lib/controlplane/db/secrets.ts`). A dump is therefore free of credentials in
principle, but it is still **tenant data**: principal ids and names, account ids,
role ARNs, and the signed envelopes of queued runner jobs (short-lived). Encrypt
backups and control who can read them like the database itself.

## 2. Backups

### 2.1 Platform store

```bash
# custom-format dump of the platform schema only
# DIRECT_DB_URL: the database's direct connection string, not the pooler's
pg_dump --schema=platform -Fc -f platform.dump "$DIRECT_DB_URL"
```

Use a **direct** connection for `pg_dump`, not the transaction pooler: a dump
needs a session. If your provider offers point-in-time recovery, prefer it: the
interesting rows change every minute (leases, operations, events) and a nightly
dump loses up to a day of audit. Supabase's backup and point-in-time options
depend on the plan; check yours. Neither was used here.

Restoring into an empty database (rehearsed, see section 8):

```bash
createdb zenith_platform_restored
pg_restore -d zenith_platform_restored platform.dump
npm run migrate:platform -- --status --url postgres://.../zenith_platform_restored   # exit 0 = current
```

When the target is another cluster whose roles differ (for example Supabase's
`anon`, `authenticated`, `service_role`), restore with `--no-owner --no-privileges`
and then re-apply `supabase/migrations/0026_platform_core.sql` (the emitted platform aggregate). It is idempotent
and puts back row level security and the role grants; rehearsed against plain
Postgres (25 tables, all with row level security on afterwards), not against
Supabase.

### 2.2 Product store and secrets

Covered by [RUNNING.md](../../RUNNING.md) and [HOSTED-POSTGRES.md](../../HOSTED-POSTGRES.md);
not repeated. Two reminders that bite during recovery: the file store is
single-writer, so stop the process before copying `<ZENITH_DATA>` (the docs make
no promise about a live copy), and keep `ZENITH_SECRET_KEY` somewhere that does
not die with the host, because losing it loses every stored secret value.

### 2.3 Temporal

- **Temporal Cloud:** retention and export are namespace settings in Temporal;
  nothing here was verified against Cloud.
- **Self-hosted:** back up the database under it, as Temporal documents.
- **`temporal server start-dev`:** history is **in memory** unless you pass
  `--db-filename`; it is for development only.

Workflow payloads hold ids, digests and redacted summaries and use the shared
AES-256-GCM codec (`src/lib/workflows/codec.ts`). Preserve the current and
decrypt-only previous keys separately from Temporal backups: losing a required
key loses access to those payloads. Legacy plaintext remains readable; ids,
visibility/search attributes and default failure messages are not encrypted.
Runtime serialization and heuristic redaction are not a blanket guarantee.
Restrict history access/retention; this sync did not run the opt-in encrypted
replay/history checks. Rotation is in [section 6](#6-key-rotation).

### 2.4 Customer OpenTofu state

The state bucket is created by the customer's bootstrap stack
(`deploy/aws/zenith-connection.cfn.yaml`, see [AWS-SETUP.md](AWS-SETUP.md)), in the
customer's account:

- versioned, private, encrypted (SSE-S3, or SSE-KMS when the customer supplies a
  key), TLS-only;
- **retained when the stack is deleted** (`DeletionPolicy: Retain`): revoking
  Zenith does not delete the customer's state;
- non-current versions expire after **180 days** (a lifecycle rule): state history
  older than that is gone unless the customer changes the rule;
- Zenith's deploy role **cannot** delete the bucket, reconfigure it, or delete
  object versions.

So recovery of a bad state write is the customer's S3 version history, not
something Zenith restores. State is also where a recovered control plane picks up
from: a rebuilt Zenith with the same connection sees the same state through the
same bucket, which is the point of keeping it in the customer's account. This
design property is from the template and the OpenTofu backend settings
(`encrypt`, `use_lockfile`); no real state has been written.

That retention policy describes the AWS bootstrap only. For GCS, Azure Blob and
OCI Object Storage, see [state selection](DEPLOYING.md#214-customer-state-backends),
provision backup/versioning on the customer's storage and rehearse restore
before relying on it. No corresponding live backup/restore is verified here.

### 2.5 Keys and configuration

Keep local worker plan files private; their availability after a replica loss
is not verified. Back up the **secret manager entries** for the signing keys,
`ZENITH_SECRET_KEY`, `ZENITH_RUNNER_RESULT_KEY` (if you set it) and the database URL, and the
list of variables in
[DEPLOYING.md section 2](DEPLOYING.md#2-environment-variables). A KMS signing key
is recovered by your KMS account's controls, not by Zenith.

## 3. Disaster recovery order

The order matters because the stores do not share a transaction: the platform
store, Temporal and the customer clouds each hold part of the truth, and the
rule is to **stop everything that can act before restoring anything**.

1. **Stop the actors.** Scale the execution worker to zero and stop any runner.
   Put the web app in maintenance (or stop the routes that start operations).
   Reason: a worker that survives a restore can act on a ledger that no longer
   matches what it remembers (see [section 4.6](#46-restoring-to-an-earlier-point-in-time-is-not-free)).
2. **Restore the platform database** (or promote a replica / point-in-time
   recovery). Confirm with `npm run migrate:platform -- --status`: exit 0 means
   the ledger is present, nothing is pending, nothing is tampered.
3. **Apply pending migrations** if the backup is older than the code
   (`npm run migrate:platform`). A backup *ahead* of the code is accepted.
4. **Decide what to do with Temporal.**
   - Platform store restored to an **earlier** point, Temporal intact: Temporal is
     ahead of the ledger. Terminate every open operation workflow before workers
     start (command below), and treat the operations they covered as uncertain.
   - Temporal lost, platform store intact: running operations have no workflow.
     The store notices when their execution lease lapses (step 6).
   - Both restored: terminate open workflows anyway unless you know both come
     from the same instant.
5. **Let leases settle.** A lease in the restored data is honoured until its
   `expires_at` (database clock): rehearsed. Workflow leases live 5 minutes.
   Wait that long, or look (section 5), before anything acts.
6. **Run the reconciler** by hand: `reconcileOperations(db)` turns `running`
   operations whose execution lease lapsed, or whose environment lease is gone,
   into `uncertain` and expires proposals nobody acted on. There is **no script or
   timer for it on this branch**; call it from a one-off script or a REPL against
   the restored store.
7. **Review the `uncertain` operations** (section 4.5), and every operation that
   was approved or running at the time of the loss, before re-enabling work.
8. **Restore keys** if they were lost (section 6), then bring up the web app and
   check `GET /api/oidc/jwks`.
9. **Start the workers.** Confirm `execution worker ready` and pollers in Temporal.
10. **Verify connections** with `AwsCredentialBroker.verifyConnection` (it assumes
    the observe role and checks the account id).

Terminating open workflows (verified on a local dev server; ids are
`op-<operationId>` and `reconcile-<environmentId>`):

```bash
temporal workflow terminate \
  --query '(WorkflowId STARTS_WITH "op-" OR WorkflowId STARTS_WITH "reconcile-") AND ExecutionStatus="Running"' \
  --reason "platform store restored" --yes
```

Whether Temporal Cloud namespaces support the same query was not checked.

## 4. What happens to an operation when something crashes

### 4.1 The vocabulary

An operation moves through `proposed`, `awaiting_approval`, `approved`, `queued`,
`running` and ends in one of `succeeded`, `failed`, `uncertain`, `cancelled`,
`expired`, `rejected`, `denied` (`OperationStatus` in
`src/lib/controlplane/types.ts`; legal edges in `ALLOWED_TRANSITIONS`,
`src/lib/controlplane/db/repos/operations.ts`).

**`uncertain` means the control plane cannot prove whether an external side effect
happened**: a worker crashed mid-call, a lease was lost, a timeout hid the
result. It is **terminal for automation**. Nothing re-dispatches it, nothing
retries it, nothing rolls it back. Reconciliation observes what is actually
there, and a person or a new operation decides.

### 4.2 Three layers, each with its own clock

| Layer | What it protects | What marks it uncertain | Function |
|---|---|---|---|
| Temporal activity | A mutating activity (apply, deploy, migrate, capability execution) | Heartbeat timeout of 60 s after a crash or partition; **one attempt only**, never replayed | `ACTIVITY_OPTIONS` in `src/lib/workflows/definitions/policies.ts`; classification in `definitions/failures.ts` |
| Ledger execution lease | An operation in status `running` | `lease_until` lapsed (default 60 s window, extended by `heartbeat`), or the recorded environment lease is gone | `markUncertainExpired`, called by `reconcileOperations` (`src/lib/controlplane/operations/index.ts`) |
| Environment lease with a fence token | All mutation of one environment (`env:<environmentId>`) | The holder cannot renew before two thirds of the TTL, so it stops | `withLease`, `assertFence` (`src/lib/controlplane/leases`, `db/repos/leases.ts`) |

The workflow finalises a crashed mutating step as `uncertain` and releases the
lease itself; the store-level reconciler is the backstop for when the workflow is
gone too (Temporal lost, or the worker died before it could write the status).
Both paths end in the same place. The full workflow table (what each failure
becomes, which steps "may have acted") is in
[EXECUTION-WORKER.md](../EXECUTION-WORKER.md#final-statuses).

The broker owns the **single-use gate** to execution (`beginExecution`,
`src/lib/capabilities/execution.ts`): it re-loads the operation, optionally compares a
regenerated plan with the approved one (`plan_changed`), **re-evaluates policy under the
current bundle**, requires that unconsumed, unexpired approvals satisfy the *current*
requirement (`approval_required` or `reapproval_required`), checks the signer works
before anything is consumed, then atomically verifies the digest, consumes the
approvals and moves the operation to `running` (`already_claimed` for every concurrent
caller but one), and issues a single-use grant. `completeExecution` ends a running
operation and revokes any grant still live; `markUncertain` ends it `uncertain`.
Product deploys (`src/lib/bridge/lifecycle.ts`), MCP approved execution
(`src/lib/agent-access/v3/tools/execute.ts`) and allowed repair dispatch
(`src/lib/platform/reconcile.ts`) call the claim gate before starting workflows.
`src/lib/platform/broker.ts` checks running operations and consumed approvals for
activity grants; it does not treat a claim as a successful mutation.

### 4.3 Moment by moment

| When it stops | What happens | Status |
|---|---|---|
| Between steps of a workflow | Another worker resumes from history; nothing re-runs | unchanged |
| During a read or plan | The activity is retried per its policy | unchanged |
| During a mutating step | Heartbeat times out after 60 s; not retried; the workflow writes `uncertain` and releases the lease; reconcile observes | `uncertain` |
| Before any mutating step started | Lease lost or busy: nothing was changed | `failed` |
| Worker and Temporal both gone | Execution lease lapses; the next `reconcileOperations` pass marks it; grants are revoked; an `operation.uncertain` event is appended | `uncertain` |
| `completeOperation` arrives after the reconciler already made it `uncertain` | It returns `null`; the caller **must not** report success | `uncertain` |
| Proposal or approval never acted on | `expireOverdue` (inside `reconcileOperations`): pre-execution statuses past `expires_at` (default 24 hours, bounds 1 minute to 7 days) | `expired`; grants revoked |
| Awaiting approval for 24 hours | The workflow gives up | `expired` |
| Database unreachable | Renewals fail; the holder stops before the lease can lapse; the operation is reconciled, not retried. The terminal status write is retried by Temporal for up to an hour. | `uncertain` |

### 4.4 Runner jobs

A job queued for a customer-network runner is claimed by poll and settled once.
`jobs.expireStale` (`src/lib/controlplane/db/repos/jobs.ts`) is the reaper: an
unclaimed job past its expiry becomes `expired`, a claimed or running job whose
lease ended becomes `timed_out`, and **nothing is re-queued**. It returns the jobs
so the caller can reconcile each owning operation to `uncertain`. The control-plane
side now exists (`src/lib/runners`, routes under `/api/platform/v1/runners` and
`/machines`), and so do the Go agents ([RUNNER.md](../RUNNER.md),
[ZENITHD.md](../ZENITHD.md)). `reapExpiredJobs` (`src/lib/runners/service.ts`) runs
the reaper for both the runner queue and the `zenithd` queue, and
`awaitRunnerJob` (`dispatch.ts`) never re-dispatches: a job it stops waiting for is
cancelled, so a late result from the agent gets `409 already_settled` and is
discarded, and the operation is reconciled by observing reality.
`src/lib/server/cron.ts` calls `platformRunnerReaperPass` from cron passes and its
long-lived scheduler. `src/lib/platform/app.ts` calls `reapExpiredJobs` and marks
owning operations uncertain in the same transaction. AWS runner credential
sessions enqueue/await through `src/lib/runners/aws-runner-transport.ts`;
the machine activity path requires an injected port absent from default worker
composition. The separate
`reconcileOperations` ledger backstop runs in the leased housekeeping pass. The `zenithd` queue's table, `platform.machine_requests`, is migration 3
([DEPLOYING.md](DEPLOYING.md#32-migrating)). Results are sealed at rest; a result that cannot be
opened (lost or rotated sealing key) leaves its operation `uncertain`.

### 4.5 What to do with an `uncertain` operation

Do not confuse two things both called reconciliation. `reconcileOperations` (the
store function above) moves stale **operations** to `uncertain` or `expired`. The
**reconciliation controller** (`src/lib/reconcile`, `POST /api/internal/tick/reconcile`)
observes an environment, diffs it against its desired graph, records drift and files
`drift.repair` *proposals* through the broker; it never changes an operation's
status and it never mutates infrastructure itself. Production ports are wired
in `src/lib/platform/app.ts`, and the five-minute tick includes its route.
Allowed repair proposals dispatch through `src/lib/platform/reconcile.ts` to
day-two workflows; unsupported execution may still fail. An uncertain operation
is not resumed by that dispatch
([DEPLOYING.md](DEPLOYING.md#29-reconciliation-tick)).

1. Read its events (`operation.uncertain`, `lease.lost`, step events) and its
   `error` text: "whether the change was applied is unknown".
2. **Observe before acting.** The reconcile workflow
   (`reconcileEnvironmentWorkflow`) observes and reports; it does not repair
   (`allowAutoRepair` is accepted and echoed as `repair: "not_implemented"`).
3. For infrastructure, plan again: OpenTofu's state in the customer's bucket is the
   record of what was applied, and a fresh plan shows what remains.
4. Decide with a person. A retry is a **new proposal** with a new id, through
   policy and approval as usual; an `uncertain` operation is never resumed.

### 4.6 Restoring to an earlier point in time is not free

**Reasoned from the schema and the code; not rehearsed with the composed execution
activities** (`src/lib/platform/execution.ts`). A restore to time T rewinds everything
written after T, including state that exists only to be single-use or monotonic:

- **Approvals and grants.** An approval is consumed when an operation is claimed
  (the broker's `beginExecution` calls `claimForExecution`), and a grant is consumed
  (`capability_grants.consumed_at`) or revoked in the ledger. After a restore, an
  approval or grant used after T looks unused, and an operation that ran after T can
  look `approved` again. A grant verifies for at most one hour
  (`MAX_GRANT_LIFETIME_SEC`); the ones `beginExecution` issues live at most 15 minutes
  (900 s, less if policy or the operation's own expiry says so), so outstanding grants
  expire on their own quickly; rotating the control signing key **without** keeping
  the old public key in `ZENITH_CONTROL_EXTRA_PUBLIC_JWKS` invalidates all of them at
  once.
- **Revocations and registrations.** A runner or `zenithd` revoked after T is
  `active` again in the restored database until someone revokes it again, and an agent
  registered after T is unknown to it and must re-register with a new token. The
  signed-request nonce window (10 minutes) loses its recent entries, so a request
  replayed inside that window after the restore is not recognised as a replay.
- **Fence tokens.** The counter per scope is monotonic for the life of the
  database, not across a restore. `assertFence` checks the token against the live
  lease but not the holder, so a worker that survived the restore holding fence N
  could pass while a new holder also has fence N. This is why step 1 of section 3
  is "stop the actors", and why workers must not outlive a restore.
- **Operation statuses and events.** Operations that finished after T revert; the
  audit events written after T are gone. The gap is real and should be recorded
  somewhere outside the database.

Mitigations, in order of strength: restore to the latest possible point (PITR),
stop all workers and terminate open workflows first, wait an hour (or rotate the
control key), then have a person review every operation that was approved, queued
or running near the loss.

## 5. Leases and fence tokens

Mutual exclusion is **rows in `platform.leases`**: no advisory locks, no session
state, so it works through the transaction pooler.

- One row per scope, **kept forever**. A released or expired lease keeps its row
  and its `fence_token`; every new acquire increments it, so a stale holder can be
  recognised (`assertFence`). Scopes: `env:<environmentId>` (every mutation of an
  environment), `reconcile:<environmentId>` (a reconcile pass),
  `connection:<connectionId>`, `resource:<resourceId>`.
- **Time is the database's** (`clock_timestamp()`), never a client clock, so clock
  skew between workers does not matter. A lease is valid while `expires_at` is in
  the future and it has not been released.
- `acquire` returns nothing when another holder has an unexpired lease; the same
  holder re-acquiring succeeds and **increments the fence**, making its old
  `Lease` value stale.
- `renew` needs the same holder, the same fence, an unexpired and unreleased lease;
  it returns nothing when the lease is lost, and the holder must stop.
- `withLease` renews at a third of the TTL (30 s default TTL), and aborts its
  signal with `LeaseLostError` if a renewal reports the loss **or the database has
  been unreachable for two thirds of the TTL**. If the lease was lost at any point
  it throws even when the work returned normally: the work ran without exclusion
  for an unknown interval, so its outcome is `uncertain` and must be reconciled,
  not retried.
- Every fenced write begins with `assertFence` inside its transaction, which locks
  the lease row `FOR SHARE`, so a takeover cannot commit between the check and the
  writes.
- Workflow leases (`env:<id>`) live **5 minutes** and are renewed before every step.
  Waiting for approval holds no lease.
- **There is no operator command to break a lease.** The supported way out of a
  stuck lease is to wait for it to expire.

A read-only look at who holds what (column names from migration 1):

```sql
select scope, holder, fence_token, acquired_at, renewed_at, expires_at, released_at,
       (expires_at > clock_timestamp() and released_at is null) as live
  from platform.leases
 where workspace_id = '<workspace>'
 order by scope;
```

## 6. Key rotation

The mechanics and exact steps are in
[`src/lib/credentials/OPERATIONS.md`](../../../src/lib/credentials/OPERATIONS.md#rotation);
the summary and the parts that depend on where each variable lives:

| Key | Who needs what during a rotation | Overlap to keep |
|---|---|---|
| **OIDC issuer key** (RS256) | The JWKS endpoint (web app) publishes current plus extra public keys. AWS IAM caches the JWKS and that cache is not under your control. | Publish the **next** public key in `ZENITH_OIDC_EXTRA_PUBLIC_JWKS` and deploy; wait at least 24 hours; make it the signer and move the old public key into `EXTRA`; after at least one more hour (tokens live up to 5 minutes, sessions up to an hour) remove the old one. |
| **Control signing key** (Ed25519) | Verifiers pin public keys: the worker, and the runner and `zenithd` agents. The signer is the broker. | Give every **verifier** the next public key in `ZENITH_CONTROL_EXTRA_PUBLIC_JWKS` first; then swap the signer; keep the old public key at least one hour (`MAX_GRANT_LIFETIME_SEC`) after the swap so outstanding grants still verify. (**Reasoned** ordering: a signer that starts signing before verifiers trust its key makes every new grant fail.) Runners learn new keys from heartbeats at least 24 hours ahead ([RUNNER-PROTOCOL.md](../RUNNER-PROTOCOL.md)); the Go agents accept and pin announced `nextKeys` per [RUNNER.md](../RUNNER.md), and the control-plane side that announces them is `announcedNextKeys` in `src/lib/runners/runtime.ts` (from `ZENITH_CONTROL_EXTRA_PUBLIC_JWKS`), which has not run against the agents. |
| **Temporal payload key** (derived from `ZENITH_SECRET_KEY`) | Web clients and workers encrypt with the current key and decrypt with it plus `ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS`, a private JSON array. | Keep every prior key needed for active and retained/archived histories; there is no automatic re-encryption. This overlap does not re-wrap the product vault or preserve plan fingerprints. |

Also:

- **Suspected compromise of the OIDC key:** rotate immediately, skipping the wait,
  and tighten trust on affected customer accounts. A forged token is bounded by the
  customer's trust policy: it needs the exact `sub` and audience and reaches only
  the observe and deploy roles ([OPERATIONS.md](../../../src/lib/credentials/OPERATIONS.md#rotation)).
- **Changing the issuer URL is not a rotation.** Customers pin the issuer in their
  IAM OIDC provider; a new URL means every account redeploys its bootstrap stack.
- **Losing the OIDC key with no overlap** means tokens signed with a new key are
  rejected until AWS refetches the JWKS: expect a window in which
  `AssumeRoleWithWebIdentity` fails. **Reasoned** from the JWKS caching note in
  OPERATIONS.md.
- **KMS-backed keys** rotate the same way: change `ZENITH_OIDC_KMS_KEY_ID` and
  publish the old key's public half in `EXTRA`. Not verified against real KMS.
- **The result-sealing key.** Runner and `zenithd` results are sealed at rest under
  `ZENITH_RUNNER_RESULT_KEY`, or, when that is unset, under a key **derived from the
  control signing JWK's private scalar**. Swapping the control signing key therefore
  changes the sealing key too, and results still in flight become unreadable (their
  operations end `uncertain`). Set `ZENITH_RUNNER_RESULT_KEY` explicitly to decouple
  the two, and keep the same value on the web app (which seals) and the worker (which
  opens). With a KMS-backed control signer it must be set (there is no private scalar
  to derive from). Source: `src/lib/runners/seal.ts`.
- **`ZENITH_SECRET_KEY`** also encrypts the product secret store and derives plan
  fingerprints. [Product-vault key re-wrap](#product-vault-key-re-wrap) migrates
  existing vault rows; the Temporal previous-key option covers Temporal only.
  Arrange vault migration and fresh review of plans before resuming operations
  after changing this shared key. For a coordinated payload rotation, first give
  all clients/workers both old and next keys as decrypt-capable keys, then switch
  the current key while retaining the old one. Keep keys outside histories,
  logs and tickets; test replay in the isolated environment before rolling out.
  Removing a required key makes histories unreadable. Source:
  `src/lib/workflows/codec.ts`; details in
  [EXECUTION-WORKER.md](../EXECUTION-WORKER.md#payload-encryption). Production
  rotation/recovery was not rehearsed here.
- **The Temporal API key and the database password** are plain secrets: rotate in
  the secret manager and restart the processes that read them. Both are read at
  start-up; the worker does not hot-reload.

### Product-vault key re-wrap

`scripts/vault-rewrap.ts` rotates the encryption key of existing product-vault
values without changing their references, plaintext values, value versions,
timestamps or actors. The AES-256-GCM format and workspace/reference AAD stay
compatible with existing rows. It supports `<ZENITH_DATA>/secrets.json` and
`public.secrets`; it does not migrate platform rows or Temporal histories.
Local file and PGlite tests cover this path. Production Postgres, pooler/TLS,
multi-process crash recovery and coordinated rollout are **not rehearsed** here.

1. Back up the product store and keep every required old key in the secret
   manager separately from the backup. Existing backups still need their old
   keys after the current store is re-wrapped. Check the actual product backend:
   `ZENITH_STORE=file` uses `ZENITH_DATA`; `ZENITH_STORE=postgres` requires
   `SUPABASE_DB_URL` and access to `public.secrets` and `public.audit_events`.
   A platform-only database URL is insufficient; the command runs no migrations.
2. Deploy the previous-key-capable readers to every vault consumer. Before
   switching the current key, include the next key in
   `ZENITH_VAULT_PREVIOUS_SECRET_KEYS` so readers can open either generation.
   This private JSON array accepts 32-byte hex or base64 keys; use 64-hex keys
   when sharing them with Temporal and plan-fingerprint consumers. Inject keys
   through protected environment configuration; never put them in CLI arguments,
   shell history, logs, screenshots or tickets.
3. Pause new operations, drain in-flight work, and stop all product-vault writers
   (web processes, workers and maintenance scripts). Keep them stopped through
   preflight and apply. Set the operator process's `ZENITH_SECRET_KEY` to the new
   key and its `ZENITH_VAULT_PREVIOUS_SECRET_KEYS` to all required old keys.
   Configure Temporal overlap separately with
   `ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS`; changing the shared current key also
   invalidates old plan fingerprints, so obtain fresh browser review of plans.
4. For each workspace id from the product workspace inventory, run a rehearsal:

   ```powershell
   npx tsx --env-file-if-exists=.env.local scripts/vault-rewrap.ts --workspace <workspace-id> --batch-size 100 --dry-run
   ```

   The command refuses missing/invalid workspace ids, duplicate/unknown flags,
   and batch sizes outside 1–1000. It authenticates every selected workspace row
   in bounded pages before changing anything. A missing/wrong key or altered
   row fails preflight without partial writes, even on the last page. Dry-run
   neither writes ciphertext nor appends audit or drains the audit outbox.
5. Apply with the same protected environment, omitting `--dry-run`:

   ```powershell
   npx tsx --env-file-if-exists=.env.local scripts/vault-rewrap.ts --workspace <workspace-id> --batch-size 100
   ```

   Output is JSON with numeric counts only: `inspected`, `candidates`,
   `rewrapped`, `unchanged`, and `batches`. Dry-run reports candidates but
   `rewrapped=0` and `batches=0`; apply emits cumulative counts after each
   committed batch and a final report. Exit codes are 0 for success, 1 for a
   sanitized failure, and 2 for invalid CLI usage. No values, references,
   workspace names, key ids or connection strings are printed.
6. Repeat dry-run and require `candidates=0` for **every workspace**, then test
   vault resolution through the application. Restart all consumers with the new
   current key and old decrypt-only keys. Retain old vault keys until no current
   rows need them and the associated backups expire; retain Temporal keys for
   as long as their active, retained or archived histories need them.

Postgres locks each page's rows and commits ciphertext plus a count-only
`system.rewrapVault` audit event in the **same transaction**. An audit failure
rolls back that batch. The file backend holds the existing exclusive
`secrets.json.lock` while it commits each batch by atomic rename, including a
`pendingRewrapAudit` outbox in that snapshot. It appends those events to
`audit.jsonl` and drains the outbox after commit. This is **at least once** audit
delivery: a crash after append but before outbox removal can duplicate an event
with the same id; deduplicate those ids when consuming the trail. There is no
transaction spanning two filesystem files, and the file store still loads and
rewrites the whole snapshot even though crypto work is bounded per batch.

After interruption, rerun the same command with the same keys and workspace.
Completed batches remain committed; rows already authenticated by the current
key are skipped without rewriting their bytes, and pending file audit events
are delivered on the next apply, even when no ciphertext needs changing. On a
hard process crash a stale file lock can remain. Verify that every writer is
stopped before removing only `<ZENITH_DATA>/secrets.json.lock`; the tool never
breaks a lock automatically. If a row changes to an unreadable value after
preflight, its batch fails but previous committed batches remain; quiescing
writers is required for the preflight guarantee across the whole run.

## 7. Migrating the platform schema forward

The rules, all enforced in code (`src/lib/controlplane/db/migrator.ts`,
`migrations/index.ts`):

- **Append-only.** A migration that has shipped is never edited. A change is a new
  module with the next version number (contiguous from 1). Migrations are DDL only
  and idempotent.
- **Checksum guard.** `platform.schema_migrations` records the SHA-256 of each
  migration's SQL. An applied migration whose checksum differs from the code is
  refused with `schema_tampered`; nothing further is applied. Remedy: restore the
  original migration text and add a new migration for the change.
- **One transaction per step**, taken with its ledger row under a table lock, so a
  failure leaves neither, and two migrators racing serialise.
- **Ahead is fine, behind is not.** A database ahead of the build is accepted (a
  newer deploy migrated it), so a rolling deploy or a code rollback keeps working
  against an additive schema. A database behind the build makes the app fail
  closed with `schema_behind` and the exact command to run.
- **No down migrations.** The only way back is a restore.

Procedure for a release that adds a migration:

1. Take a backup (section 2.1).
2. `npm run migrate:platform -- --dry-run` against production: lists what will be
   applied.
3. `npm run migrate:platform`, then `-- --status` (exit 0).
4. Roll out the new application. (If the release also changes the emitted SQL,
   `npm run platform:emit-sql -- --check` must pass before you ship.)

## 8. What was rehearsed

Historical WS-DOCS rehearsal record, not rerun in this sync: on 2026-09-30
against PostgreSQL 16.15 (the `zenith-dev-postgres` container;
scratch databases, dropped afterwards), using the store's own functions:

| Step | Observed |
|---|---|
| `migrate --url` into an empty database | Applied migration 1; ledger present |
| Acquire the same scope twice as the same holder | Fence 1, then 2 |
| Propose, approve and `claimOperation` an operation under that lease | `running` with fence 2 |
| `pg_dump --schema=platform -Fc`, `pg_restore` into an empty database | Succeeded; the restore created the schema |
| Migration status on the restored database | Current (exit 0) |
| The restored lease | Still held by the old holder until its 60 s expiry; a second holder was refused |
| `reconcileOperations` on the restored store, after the execution lease lapsed | The running operation became `uncertain` with the "executor stopped reporting" error |
| Acquire after the restored lease expired | Fence 3: the counter survived the dump and restore |
| Emitted SQL applied twice, then the TypeScript migrator's `--status` | Idempotent; status current |
| `pg_dump --no-owner --no-privileges` and restore, then re-apply the emitted SQL | All 25 tables have row level security on; status current |
| `temporal workflow terminate --query` with `STARTS_WITH` on a dev server | Terminated `op-` and `reconcile-` workflows, left others |

That rehearsal ran against migration 1 (`core`), before migration 2 (`reconcile`) merged
into this branch, and could not be repeated afterwards because the Docker engine was
not running. Migration 2 was applied and checked on PGlite
(`npm run migrate:platform`, then `-- --status`: both applied, current) and is
covered by the repository's own suites; its dump and restore, and the table counts
above, were not re-observed on Postgres.

**Not rehearsed:** a restore to an earlier point in time with live workers and
workflows (section 4.6); Supabase's own backup and restore; Temporal Cloud; any
recovery with the now-composed execution activities; a runner reaping jobs against a
live control plane; a load of realistic size (the drill wrote a handful of rows).


## Wave 5 restore continuation

[RESTORE-RUNBOOK.md](RESTORE-RUNBOOK.md) supersedes the old post-restore fence/approval continuation instructions: schema 46 bumps installation recovery epochs, expires lost-timeline leases, revokes resurrected grants and holds ambiguous work for a person. Start no worker until the Temporal termination/continuation hand-off is complete. Post-snapshot effects are invisible to the backup and still require reconciliation with each provider. `ops:recovery restore` publishes incident/snapshot/restore instants to the SLO recorder as a `recovery-drill`; this is database recovery timing, not application-health RTO. Failed publication is an explicit report hand-off. [Assembly verification](../../build/production/verify/W5-ASSEMBLY.md).
