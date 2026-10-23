# Teardown after deploy: delivery settlement and a direct-path cleanup origin

Status: proposal, 24 October 2026. Needs independent security review and an owner decision before any code changes.
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

## Decision requested from the owner

Accept option B, its residual risk and the wait after a deploy, and approve building the direct-path origin? Until
then, teardown after deploy remains unsupported and the affected requirements stay open.
