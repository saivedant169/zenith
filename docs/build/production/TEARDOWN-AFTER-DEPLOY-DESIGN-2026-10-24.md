# Teardown after deploy: delivery settlement and a direct-path cleanup origin

Status: proposal, 24 October 2026. Needs independent security review and an owner decision before any code changes. Decided on 26 October 2026: see "Decisions (2026-10-26)" at the end.
Affects PROD-LIFE-07, PROD-LIFE-11 and PROD-MIX-04 (see `docs/LIMITATIONS.md`, "Teardown after deploy").

## Problem

On the operated LIFE-11 journey (hosted runs on `190db611` and `dcadf325`), an approved production teardown planned
correctly and then ended `uncertain` before deleting anything. Two independent reasons, both deliberate:

1. **No direct-path origin.** Destroy write grants (`infrastructure.destroy`) are issued only when
   `readNativeCleanupOwnerGrantOrigin` (`src/lib/platform/plan-artifacts.ts`) finds the private cleanup cell. Only the
   OpenTofu plan-artifact `consume` path creates it, after `retainCleanupWriterHold` inserts a row into
   `platform.cleanup_writer_holds` (migration 15). Direct Kubernetes and Zenith-managed teardown has no plan artifact,
   so its grant always fails with `cleanup_writer_unconfirmed`.
2. **Every earlier delivery blocks.** The hold is refused unless the environment's possible-delivery inventory
   (`inventoryWithSettlements`, `src/lib/controlplane/db/repos/cleanup-writer-barriers.ts`) is all zero. It counts
   every non-read capability grant, every `workflow_start_intents` row in `attempted` or `acknowledged` (no terminal
   phase exists), every build launch, every started runner or machine job, every immutable delivery row and every
   plan use without an authenticated standalone settlement receipt. Settlement receipts exist only for builtin
   `terraform_data` saved plans. So once an environment has been deployed through a workflow, teardown is refused on
   every provider path.

The 5 October cleanup handoffs record both points ("Direct Kubernetes/Zenith destruction still refuses without
supported paired native origin"; "Safe same-scope apply-then-destroy requires authenticated provider settlement;
terminal operation, revoked grant or succeeded projection alone does not prove quiescence").

## What the barrier protects against

A writer from an earlier operation (a worker activity, a zombie worker after a crash, a runner job, a build) could
still change provider state while teardown runs. Teardown could then delete resources a late writer recreates, or
finish while a late writer creates new ones, leaving unowned, billable resources. The barrier refuses destruction
until no earlier writer can still be writing.

## Options

### A. Keep the barrier as is

Teardown of a deployed environment stays unsupported in the product. Operators tear down with provider tooling, and
Zenith only verifies absence. This keeps today's guarantee, but LIFE-07, LIFE-11 (decommissioning) and MIX-04
cannot pass, and "safe updates ... recovery" has no supported teardown.

### B. Authenticated time-and-terminal settlement (recommended)

Add a settlement record per earlier delivery, written only by the worker under the platform key (a new AAD domain,
as standalone plan settlements use), and exclude a delivery from the inventory only when its settlement
authenticates. A delivery is settled when all of the following hold:

| Family | Settled when |
|---|---|
| Workflow start intent | the owning operation is terminal and an authenticated Temporal describe (mTLS client) reports the workflow execution closed |
| Capability grant (non-read) | now is past `expiresAt` plus the longest provider session minted from it (`LONG_SESSION_SEC`, 3600 s) plus a fixed skew margin; revocation alone is not enough |
| Runner or machine job | terminal with a signed runner result, or past the job envelope's expiry plus the same margins |
| Build launch | terminal, and its build grant is settled by the grant rule |
| Plan use | the existing authenticated standalone settlement receipt, unchanged |

Pre-epoch history and unknown coverage stay blockers, as today. Teardown then still needs a fresh review, a current
browser approval and the held attempt; settlement removes only the "earlier writer" blocker.

Residual risk the owner must accept: a provider-side asynchronous operation accepted before its credentials expired
(for example a long cloud create) can complete after teardown's verification. Mitigation: a delayed absence
re-verification (owned-object and tag inventory scan) after a fixed horizon, reported as a teardown follow-up, plus
cost reconciliation. This narrows but does not eliminate the risk.

Cost: the first teardown after a deploy waits until the last grant's horizon passes, about 1 to 2 hours worst case
with today's 900 s default grant and 3600 s sessions. Teardown long after the last deploy is not delayed.

### C. Provider-authenticated quiescence

Prove from each provider's own journal (CloudTrail, GCP operations, Azure activity log, OCI work requests, Kubernetes
audit) that no write from an earlier authority is in flight. This is the strongest proof but needs per-provider
adapters and live access, and Kubernetes audit logs are often unavailable to tenants. Possible later hardening on top
of B, not a first step.

## Direct-path cleanup origin (needed with B or C)

Direct teardown needs its own held attempt, equivalent to the plan-artifact hold:

- Bind the hold to the reviewed direct teardown plan (the `provider-teardown` `tofu_plan` evidence and its digest),
  the environment lease and fence, and the consumed browser approval of the current round, instead of a
  `plan_artifact_uses` claim.
- Insert the hold, reserve and insert the owner grant through new repository functions that follow the existing
  three-phase CTE pattern, each with the same lease, approval, product and source predicates in its final statement.
- Register them in the SQL source audit (`tests/security/controlplane-sql-scoping.test.ts`), whose hashes, counts and
  `cleanupWrites` list pin the current three functions.
- An expand-only migration if a hold column must reference evidence instead of a plan artifact.

## Verification plan

- Contract and native PostgreSQL cases for each settlement family, including refusal when any condition is missing,
  a forged or foreign settlement row, revocation without expiry, and an unclosed workflow.
- The existing cleanup46 and saved-plan settlement suites unchanged and passing.
- Operated: the D-4 adopt journey's `adopt-destroy-teardown` on kind (direct path), and a LocalStack OpenTofu
  teardown after a workflow deploy.
- Live: one AWS and one Kubernetes teardown after deploy in the approved sandbox, within the budget.

## Independent review findings (24 October 2026)

An independent security review of this proposal against the code found the following. Each changes the design.

1. **A refused teardown freezes the environment.** `retainCleanupWriterHold` (`repos/plan-artifacts.ts`) inserts the
   hold, then reads the inventory inside the same committed transaction; the caller refuses afterwards
   (`platform/plan-artifacts.ts`). The hold row is immutable (migration 15 trigger), keyed one per environment, and
   while it exists migration 0029's writer trigger refuses every new workflow, grant, plan, build, runner and machine
   delivery in that environment. A second attempt conflicts on the key and is refused. The test "an earlier
   unconsumed mutation grant blocks callback entry while the new hold still commits" shows the commit-on-refusal is
   deliberate; no test covers a later attempt. Today, approving a teardown of any deployed environment on the
   OpenTofu path therefore appears to leave it permanently undeployable and not torn down. Any settlement design needs
   a defined hold lifecycle (the same hold reused by a later attempt once settled, or a superseding generation).
2. **The direct-path origin is more than a new hold binding.** `captureCleanupFrame` needs a `plan_artifacts` row and a
   claimed `plan_artifact_uses` row, and migration 0029's grant branch requires a claimed plan use matching the hold.
   A direct origin needs a new frame from the `provider-teardown` plan evidence, a new entry point that sets the
   private invocation cell, replacements for `DISPATCH_SOURCE_AUTHORITY` and the destroy dispatch predicate, and a new
   trigger version. A migration is required, not optional.
3. **Time horizons are unsound for static credentials.** A Kubernetes connection's `credentialRef` (token or client
   certificate from the vault) has no provider-side expiry; the session's `expiresAt` is a local check. A writer still
   holding that kubeconfig keeps authority past every grant horizon. The same applies to any static customer
   credential and to customer-held runner identities. Settlement for these needs the connection credential rotated
   or revoked first (and the revocation proven), or a signed terminal result from the writer.
4. **Option B as written does not unblock OpenTofu plans.** Non-builtin plan uses stay counted. A plan-use rule is
   needed (for example terminal and past the longest session after the use's last update, measured on the database
   clock).
5. **Runner and machine jobs:** an envelope's expiry bounds the envelope, not the runner's own customer-side identity.
   Settle only on a signed terminal result.
6. **Workflow intents:** an `attempted` intent may have no run id, and a delayed start RPC can still start the run after
   a describe. NotFound must stay unsettled until the start deadline plus retry horizon has passed.
7. **Build launches** are counted with no phase filter and have no join key to a build grant; the rule must name both.
8. **Clock and authority:** a settlement timestamp signed by a worker could clear a delivery early if that worker is
   compromised. The horizon must be computed in the inventory SQL with the database clock, and an insert trigger must
   refuse a settlement before its horizon.
9. **Stated assumption:** plan and observe grants, and read-only runner work, are excluded from the inventory. That is
   safe only if those credentials cannot write; connection verification should check it.
10. **Audit coverage:** `inventoryWithSettlements` is not pinned by the SQL source audit; any settlement predicate added
    there, and the new direct-path functions, must be pinned with hashes and counts.

Revised recommendation: option B is still the practical path, but only together with (1) a defined hold lifecycle,
(3) credential rotation or signed terminal results for static and customer-held identities, and (4) to (10). That is
a substantial change to migration-15/0029 authority and its native PostgreSQL suites, with fresh independent review
of the SQL.

## Decision requested from the owner

Two decisions:

1. Is finding 1 intended? If one refused teardown is meant to freeze an environment for good, that should be
   documented and shown to the approver before they approve. If not, it needs fixing before teardown is offered.
2. Accept revised option B (time-and-terminal settlement with credential rotation for static identities), its
   residual risk and the wait after a deploy, and approve building the direct-path origin and the migration?

Until then, teardown after deploy remains unsupported and the affected requirements stay open.

## Decisions (2026-10-26)

The owner delegated these decisions on 26 October 2026. The recommended options were taken. They bind the work packages below. Recording them changes no code.

### Decision 1: a refused teardown does not freeze the environment

A refused teardown freezing an environment is not intended (finding 1). The fix uses superseding hold generations:

- Each attempt inserts its own generation row. The freeze is the newest hold with no release row.
- A release is an append-only `cleanup_writer_hold_releases` row. It is written only under the scope lock, and only when the environment's possible-delivery inventory is zero. The next retain for that environment writes it, or a janitor sweep does.
- The teardown review shows "frozen until drained" before the approver approves.

Until WP5 lands, a refused attempt still freezes the environment. `docs/LIMITATIONS.md` says so.

### Decision 2: revised option B, with its residual risk and the post-deploy wait

Revised option B is accepted, with two stated costs. First, the residual risk: a provider-side asynchronous operation accepted before its credentials expired can complete after teardown verified absence. Mitigation: a delayed absence re-verification and cost reconciliation. Second, the first teardown after a deploy waits about 1 to 2 hours at the default grant and session lifetimes.

Settlement per family. Every horizon uses `clock_timestamp()` on the database. An insert trigger refuses any settlement before its horizon.

| Family | Settled when |
|---|---|
| Workflow start intent | The owning operation is terminal and an authenticated Temporal describe (mTLS client) reports the execution closed. NotFound stays unsettled until the start deadline plus the retry horizon has passed: an `attempted` intent may have no run id, and a delayed start RPC can still start the run after a describe. |
| Zenith-brokered capability grant (non-read) | Now is past `expires_at` plus `LONG_SESSION_SEC` (3600 s) plus a fixed skew margin. Revocation alone never settles a grant. |
| Static or customer-held credential | No time rule. Settled only by a signed terminal result from the writer, or by proven rotation or revocation of the credential. Default deny. Classified server-side. This covers a Kubernetes `credentialRef`, any static customer credential and customer-held runner identities. |
| Runner or machine job | A signed terminal result only. The envelope expiry bounds the envelope, not the customer-side identity. |
| Build launch | Terminal, `provider_finished_at` set, and its build grant settled by the grant rule. Join key `(workspace_id, operation_id, service_address, attempt_id)`. |
| Plan use | Builtin: the existing authenticated standalone settlement receipt, unchanged. Non-builtin: terminal, past the latest grant horizon of the same operation, and the static-credential rule. |

### Direct-path origin

The direct-path hold is built from `provider-teardown` `tofu_plan` evidence, the environment lease and the consumed approvals of the current round. It has its own table (`cleanup_direct_attempts`, schema 60), its own entry point, its own dispatch predicate and a new trigger version. A migration is required (finding 2). Its SQL is pinned by the source audit (finding 10).

### Work packages

In this order: WP1 expand migration, WP5 hold lifecycle, WP2 inventory rules and audit pins, WP3 settlement writers, WP4 direct-path origin, WP6 wiring and UI, WP7 journeys and live. WP1 to WP5 are safety-critical. Each gets an independent adversarial review before merge.

WP1 is in this change: schema 60, expand-only. It adds the hold generation order (`cleanup_writer_holds.hold_seq`, identity by default, primary key unchanged), and three empty append-only tables: `cleanup_writer_hold_releases`, `cleanup_writer_settlements` and `cleanup_direct_attempts`. No trigger, grant or behaviour of an existing object changes.

Settlement families. The design table above lists five delivery rows. `runner` covers runner jobs and machine requests, so `cleanup_writer_settlements` records six `delivery_source` values under five `family` values. The writer's referential check against the possible-delivery ledger belongs to WP3.

### WP3 status (2026-10-28)

Built: the sealing writer (`writeDeliverySettlements` in `cleanup-writer-barriers.ts`), run by the execution worker's plan janitor before it releases drained holds, and schema 63, which adds the non-builtin plan-use rule. Settled families:

- **Grants.** After expiry plus 3,900 s.
- **Workflow starts.** When an authenticated Describe in the bound namespace reports the run closed, or NotFound past the database horizon. A continued-as-new run counts as open.
- **Build launches.** Once terminal.
- **Non-builtin plan uses.** All of the following must hold:
  - the operation is terminal;
  - the operation's latest grant horizon has passed;
  - the environment's recorded platform connection is AWS `aws_assume_role` or `oidc_web_identity`;
  - that connection was created no later than the operation.

Not settled: runner and machine jobs (they need a verified signed runner result), static or customer-held credentials, and other providers.

Independent review (2026-10-28) led to three changes:

- **Static connections.** A plan use never settles while the workspace held any non-short-lived AWS connection when its operation was created. Without this, a repointed environment could settle a static-key apply by time.
- **Temporal endpoint.** A workflow start settles only when the worker's Temporal endpoint digest equals the one the start recorded.
- **Janitor order.** The janitor releases drained holds before the settlement pass, so a failing pass cannot block release.

Open items:

- **Row limit.** The settlement rows are immutable, and the verified loader refuses more than 4,096 in one environment. That is several hundred deploys. Past it, nothing verifies and teardown is refused, which fails closed. Per-delivery verification is needed before that limit matters.
- **Managed sessions.** They run on the platform cluster credential, which a grant does not bound. Managed environments have no destroy origin until WP4, which must exclude or separately settle them.

### Private beta interim

Until this lands, teardown after deploy stays a documented limitation. The customer uses provider tooling, and Zenith verifies absence. `docs/LIMITATIONS.md` (Teardown after deploy) states it.

### WP6 status (2026-10-28)

Built: `env.teardown` reads the tenant-scoped cleanup inventory (`cleanupWriterBarriers.preview`) before proposing. A nonzero count refuses in plan and execute with the same sentence, so the confirm button is disabled before anyone approves. Untracked (pre-epoch) history gets its own sentence, because it never settles. An unreadable inventory refuses as unavailable. The worker barrier remains the authority; this is display only. Not built: an earliest-start time. It needs the per-delivery horizon exposed through a reviewed read, and is left until a customer asks for it.

### WP7 status (2026-10-28)

The live proof is one run, not two. The Zenith stack lives on the runner, so two runs would need a control plane that persists across them; this design does not add one.

Scenario `teardown-01` (`scripts/acceptance/live/product/teardown-01.ts`, scope PROD-MIX-04) runs these steps:

1. Zenith deploys one managed S3 bucket into a fresh AWS environment, with two-person browser approval. The harness reads it back from the recorded state and from the tagging inventory.
2. Right after the deploy, the teardown review's plan must be refused with the WP6 settling sentence.
3. The harness polls that plan every 2 minutes, for up to 110 minutes. The settling refusal must clear, and no other refusal may replace it.
4. The run refreshes its session.
5. Zenith tears down through `env.reviewTeardown` and every browser approval of the destroy proposal.
6. The recorded state must be empty, and no resource tagged with the environment may remain.

If the product teardown does not finish, the harness destroys the environment from its recorded state, as DEPLOY-01 does.

The write grant lives at most 900 s, and settlement adds 3,900 s. So the wait is about 80 minutes, and the run's duration envelope is up to 150 minutes. The job timeout is 200 minutes.

The OIDC session lasts one hour, so the run must refresh it. `session-refresh.ts` requests a new GitHub OIDC token for the same role and calls AssumeRoleWithWebIdentity. It checks the account, then rebuilds the harness clients (`replaceSessionCredentials`). It rewrites the stack's shared credentials file and restarts only this installation's `api` and `execution-worker` containers. Their SDK caches that file once per process. It then waits for both to report healthy.

No credential value is logged or placed on a command line. A second `configure-aws-credentials` step refreshes the session again before journal recovery.

This change also guards the review path (`env.reviewTeardown`, plan and execute), which WP6 had missed: the teardown screen uses it.

