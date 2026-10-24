# AWS live acceptance: owner runbook

DEC-CLOUD is **unapproved**. No live cloud call or spend was performed by this job. This packet builds the AWS provider-fixture layer and a narrow `ProductScenarioPort` join for the concurrently assembled Wave 5 release journeys. It never promotes a ledger state or release flag.

## What this source can prove

`scripts/acceptance/aws-live.ts --plan` prints every SDK command, IAM action, exact request input, resource scope and maximum attempt count, with a plan SHA-256 and provisional cost. It does not resolve credentials, construct an SDK client or contact a control plane. Existing A-J planning and local J remain reachable with `--scenario`; legacy real AWS journeys explicitly refuse until their clients join the exact production permission envelope. Their authority/quiescence cleanup refusals are preserved.

Live provider fixtures create one private encrypted S3 bucket and nonce object, a bounded IAM nonce-function role, one ARM64 128MiB Lambda echo function, an **empty** ECS cluster, a private encrypted 20GiB PostgreSQL RDS instance and a disposable reserved `.invalid` Route53 zone/TXT record. They independently read ownership and provider state; Lambda invokes real code and S3 compares real object bytes. Empty ECS cluster state is not a running application. RDS configuration is not SQL traffic or restore proof. Reserved-zone readback is not public DNS, domain ownership, ACME or TLS evidence.

Every ledger row requiring `live_sandbox` is included with its acceptance text and AWS fixture dependencies. Full MIX, MAN, OPS and REL journeys need Wave 5's real release integration (including GCP/Azure and managed Kubernetes where required). `ProductScenarioPort.verify` is the small join contract in `scripts/acceptance/live/contracts.ts`; this CLI intentionally has no injected implementation. It must run the product's normal quotas -> authority/intent -> semantics/authorization -> custody -> effect ledger -> provider path, use human browser approvals, prove real independent traffic/readback, and settle accepted operations before teardown. Extending its calls requires extending the deterministic plan and obtaining a new permission approval. Neither fixture success nor an interface implementation that simply returns `complete: true` is acceptable verification.

Current live CLI success for the fixtures ends with **exit 3 / incomplete**, 6 provider checks, 6 cleanup checks and 27 pending product requirements. The dispatch final gate therefore remains red until that join is integrated and verified. This is a stated integration gap, not an alternate product execution path. Commercial/retention/signoff rows do not become approved through an AWS run.

## Before any live run, after the owner's DEC-CLOUD decision

1. Use a new disposable commercial AWS account with no customer/production resources. Approve account, region, availability zones, monthly alarm budget, per-run USD ceiling and provisional regional cost assumptions. The harness cannot approve these decisions.
2. Apply `deploy/live-sandbox/aws/main.tf` as the accountable account owner, never through the live acceptance role. It creates GitHub OIDC trust, a one-hour execution role with an action-ceiling boundary and scoped identity policy, a deny-all Lambda workload boundary, `/zenith/live-sandbox=true`, a monthly budget alarm and two private DB subnets with a security group permitting no ingress. There is no NAT, EKS, ALB or paid VPC endpoint in the lean fixture profile.
3. Configure GitHub's `live-sandbox` environment with required reviewers, prevent self-review, and restrict deployment branches to protected branches/an explicit allowlist. The trust subject is exactly `repo:<github_repository>:environment:live-sandbox`, where `github_repository` is the `owner/name` that runs live acceptance (currently the fork `saivedant169/zenith`), audience `sts.amazonaws.com`. Repositories with GitHub's immutable OIDC subjects enabled send `repo:<owner>@<owner_id>/<name>@<repo_id>:environment:live-sandbox` instead; check with `gh api repos/<owner>/<name>/actions/oidc/customization/sub` and set `github_oidc_subject_prefix` to its `sub_claim_prefix` value. The fork uses immutable subjects (`repo:saivedant169@88630924/zenith@1417385376`), and the sandbox role was updated to it on 2026-10-24 after the first OIDC exchange was refused with "Not authorized to perform sts:AssumeRoleWithWebIdentity". These protections are external GitHub settings; YAML alone cannot enforce them. See [AWS's GitHub OIDC guidance](https://docs.aws.amazon.com/hi_in/IAM/latest/UserGuide/id_roles_create_for-idp_oidc.html).

   **Owner exception (2026-10-24).** The `live-sandbox` environment on `saivedant169/zenith` has one required reviewer, the owner `saivedant169`, and "prevent self-review" is OFF.
   This is an owner-approved exception to the two-person rule in the `live-acceptance.yml` header and in step 3 above, because the owner decided no second person is needed for this disposable sandbox.
   Accepted residual risk: one compromised owner GitHub account (for example, a leaked `gh` token) could both dispatch and approve a run and obtain the sandbox role.
   Mitigations still in place: disposable sandbox account 361646636162 (ap-south-1), role permissions boundary, one-hour session, tag-scoped mutations, a per-run owner-approved `awsLive` envelope bound to plan digest and source commit, approved root scope, and a $10 monthly budget alert (alert only; it does not stop spend).
   Deployment branches are limited to protected branches, and `codex/production-2026-10-02` requires PRs with 0 approvals (admins included), no force pushes and no deletion.
4. Set environment variables `LIVE_SANDBOX_AWS_ROLE_ARN`, `LIVE_SANDBOX_AWS_ACCOUNT_ID`, `LIVE_SANDBOX_AWS_REGION`, `LIVE_SANDBOX_AWS_DB_SUBNET_GROUP`, `LIVE_SANDBOX_AWS_DB_SECURITY_GROUP`. Use bootstrap outputs; the role name is `ZenithLiveAcceptance`.
5. Freeze and commit the integrated source. Generate the exact plan below with a fresh run ID and bootstrap outputs. Store its approved `permissionsProposal` in an external `permissions.json`, filling `approvedBy`, `approvedAt`, `expiresAt`, `sourceCommit` (that exact clean candidate SHA), budget and duration. Leave all unrelated Wave 5 root permission fields intact. The additive `awsLive` schema is defined in `contracts.ts`; the example is deliberately unapproved. Set protected environment variable `LIVE_SANDBOX_AWS_PERMISSIONS_JSON` to this approved non-secret document for a dispatch. Do not commit a permission's own source SHA into the source it hashes.

Integration with the assembled Wave 5 root scope: approve a separate copy of the strict root manifest using `scripts/release/permissions-cli.ts approve`, and supply its absolute path as `ZENITH_LIVE_SCOPE_FILE`. Keep `awsLive` in the separate file named by `ZENITH_LIVE_AWS_PERMISSIONS`; adding it to the root document would invalidate the root schema and approval digest. Both approvals must permit the same run, AWS actions, TTL and cost ceiling. The production CLI and pre-OIDC preflight enforce both envelopes before credentials are resolved. Store the approved root JSON in the protected environment variable `LIVE_SANDBOX_SCOPE_JSON` for dispatch. Recovery still requires current root approval for owned teardown; an expired AWS envelope alone cannot bypass it.

## Exact commands on the Mac

Node must be 22; OpenTofu must be 1.12.5. Export `ZENITH_NODE22_BIN` to the verifier's actual Node 22 directory. No Docker is needed for the provider fixtures. Use one workload at a time on the 8GB ARM64 Mac; when verifying the Wave 5 product stack, use its reduced-resource profile and keep Docker at 4GiB. Do not start a second PostgreSQL/Temporal/kind stack for these fixtures.

```bash
export PATH="$ZENITH_NODE22_BIN:$PATH"
node --version
actionlint .github/workflows/live-acceptance.yml
tofu -chdir=deploy/live-sandbox/aws init -backend=false
tofu -chdir=deploy/live-sandbox/aws fmt -check
tofu -chdir=deploy/live-sandbox/aws validate
npx vitest run tests/acceptance/aws-production.test.ts tests/ci/release-gates.test.ts --no-file-parallelism --maxWorkers=1
```

`init` downloads the pinned AWS provider; `validate` and `fmt` do not authorize a cloud plan/apply. Preserve the resulting provider lockfile for integration review. This builder could not execute the installed OpenTofu binary (Windows access denied); syntax/provider validation is unperformed. No bootstrap application is claimed.

After DEC-CLOUD, owner-only bootstrap, with the values approved in that decision:

```bash
export PATH="$ZENITH_NODE22_BIN:$PATH"
tofu -chdir=deploy/live-sandbox/aws plan \
  -var="account_id=$AWS_SANDBOX_ACCOUNT_ID" -var="region=$AWS_SANDBOX_REGION" \
  -var="budget_usd=$AWS_SANDBOX_MONTHLY_BUDGET_USD" -var="alert_email=$AWS_SANDBOX_ALERT_EMAIL" \
  -var="availability_zones=$AWS_SANDBOX_AZS_JSON" -var='dec_cloud_approved=true' \
  -out=approved-bootstrap.tfplan
tofu -chdir=deploy/live-sandbox/aws apply approved-bootstrap.tfplan
tofu -chdir=deploy/live-sandbox/aws output
```

Then generate a **credential-free** exact plan (use a fresh valid UTC run ID):

```bash
export PATH="$ZENITH_NODE22_BIN:$PATH"
npx tsx scripts/acceptance/aws-live.ts --plan \
  --account "$AWS_SANDBOX_ACCOUNT_ID" --region "$AWS_SANDBOX_REGION" \
  --run-id "$AWS_ACCEPTANCE_RUN_ID" --minutes 15 \
  --db-subnet-group "$AWS_SANDBOX_DB_SUBNET_GROUP" \
  --db-security-group "$AWS_SANDBOX_DB_SECURITY_GROUP" --out "$AWS_ACCEPTANCE_PLAN_DIR"
```

Inspect `plan.json`, approve the exact plan hash/calls/cost/clean source, then either dispatch the workflow or invoke the CLI once:

```bash
export PATH="$ZENITH_NODE22_BIN:$PATH"
ZENITH_LIVE_AWS=1 \
ZENITH_LIVE_AWS_ACCOUNT_ID="$AWS_SANDBOX_ACCOUNT_ID" \
ZENITH_LIVE_REGION="$AWS_SANDBOX_REGION" \
ZENITH_LIVE_AWS_RUN_ID="$AWS_ACCEPTANCE_RUN_ID" \
ZENITH_LIVE_AWS_DB_SUBNET_GROUP="$AWS_SANDBOX_DB_SUBNET_GROUP" \
ZENITH_LIVE_AWS_DB_SECURITY_GROUP="$AWS_SANDBOX_DB_SECURITY_GROUP" \
ZENITH_LIVE_AWS_BUDGET_USD="$AWS_ACCEPTANCE_BUDGET_USD" \
ZENITH_LIVE_AWS_PERMISSIONS="$AWS_ACCEPTANCE_PERMISSIONS_FILE" \
ZENITH_LIVE_SCOPE_FILE="$AWS_ACCEPTANCE_SCOPE_FILE" \
ZENITH_LIVE_AWS_SESSION_FILE="$AWS_ACCEPTANCE_SESSION_FILE" \
ZENITH_LIVE_AWS_OUT="$AWS_ACCEPTANCE_EVIDENCE_DIR" \
npx tsx scripts/acceptance/aws-live.ts
```

The session FILE is an owner-issued **short-lived** JSON session with `accessKeyId`, `secretAccessKey`, `sessionToken`, and `expiration` with 46..60 minutes remaining to cover execution plus cleanup; provide only its absolute path. Never place its contents in code, commands, logs or evidence. Local environment credentials, profiles, IMDS, credential processes and endpoint overrides cannot supply a fallback. GitHub dispatch uses the pinned official OIDC action and its protected environment's one-hour session; no stored access key is configured.

Equivalent dispatch after external environment approval:

```bash
gh workflow run live-acceptance.yml --ref "$AWS_ACCEPTANCE_APPROVED_REF" \
  -f run_id="$AWS_ACCEPTANCE_RUN_ID" -f budget_usd="$AWS_ACCEPTANCE_BUDGET_USD"
```

The full fixture test is separate, real and gated. It expects exit 3/incomplete for this source, then independently inspects 6 actual fixture checks, 6 teardown checks, zero failed checks and 27 pending product rows. It cannot certify those product rows. Do not run both CLI and test for the same run ID:

```bash
export PATH="$ZENITH_NODE22_BIN:$PATH"
# With all live variables above exported for a NEW approved run:
ZENITH_LIVE_AWS=1 npx vitest run tests/acceptance/aws-production.live.test.ts --no-file-parallelism --maxWorkers=1
```

Without the flag this test is skipped, never live evidence. With the flag and missing prerequisites it fails. The separate existing IAM boundary-family acceptance remains the LIFE-03 check; use the exact gated commands in `verify/PROD-LIFE-03.md`. This fixture role is not a replacement for Zenith's deploy role.

## Budget, cleanup and evidence limits

The hard admission ceiling reserves the canonical fixed topology, maximum attempts, a 5..20 minute execution window and a 2USD cleanup reserve before **any** AWS call. It refuses an altered self-consistent cost/topology as well as unknown/unplanned calls, changed inputs, missing per-call permission, exhausted attempt counts and expired mutation permission. Before billable creation it atomically claims `/zenith/live-runs/<runId>` using Standard-tier PutParameter with Overwrite=false and independently reads it. This account-side receipt prevents replay from a new directory or another machine. The execution role cannot overwrite/delete the receipt. The bootstrap uses the documented StringEquals condition for ssm:Overwrite; see [AWS Parameter Store condition guidance](https://docs.aws.amazon.com/systems-manager/latest/userguide/parameter-store-policy-conditions.html). Non-billing receipts are intentionally retained for replay prevention, tagged with purpose live-acceptance-receipt, and excluded from workload leak discovery; deletion requires a separate accountable retention decision. Cleanup is limited to already approved teardown/read inventory, can use the original approval after its expiry, and has a 25-minute observation deadline. It cannot create new resources or claim another run in recovery mode. SDK retries are disabled; every attempt is counted and journaled before dispatch.

The 6.45USD default estimate is a conservative **provisional allowance**, not a price quotation or billing measurement. The owner must validate rates before approving it. Budget alarms are delayed billing notifications, not an account spend kill switch. AWS acknowledges billing/notification delay in [its budget guidance](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html). No system can guarantee a dollar cap or successful teardown if AWS/runner/storage is unavailable. If a truly unconditional account cap or teardown guarantee is an acceptance requirement, this lane must remain blocked on that owner decision rather than claiming one.

Every resource is named by run ID and carries `zenith:live-run`, `zenith:managed`, `zenith:purpose`. Before mutation the harness checks caller account and exact execution role, the sandbox opt-in marker, private bootstrap DB network, old tagged leaks and native presence of every planned name. Before deletion it checks all three ownership tags, deletes dependents before their prerequisites and polls each provider's native absence. A Lambda deletion failure blocks IAM role deletion. Access denied, malformed state, exhausted counters and timeouts are never interpreted as absence.

S3 and Route53 cannot both create and tag atomically in these APIs. If creation succeeds but tagging/journal persistence fails, the harness refuses to delete an untagged resource and reports a leak. An owner must resolve that positively identified orphan. Route53 creation and zone tagging/deletion cannot be restricted by resource tags in IAM: [the service authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_route53.html) documents its supported resource conditions. That account-level permission is confined to this disposable account; record mutations only allow reserved TXT names. Never use this role in an account containing unrelated DNS zones. The role cannot edit its own policies, mint access keys, fetch secret values or remove its boundaries.

The RDS-managed credential is never retrieved; [RDS deletes its managed secret with the DB](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-secrets-manager.html). The harness persists only its scoped ARN and independently checks secret absence using DescribeSecret, never GetSecretValue. ECS/RDS service-linked roles and bootstrap network/marker/policies/budget remain account bootstrap objects, not per-run leaks. The bootstrap owner precreates those service-linked roles (or proves both already exist and sets create_service_linked_roles=false); the runner cannot create them. The owner removes bootstrap infrastructure separately after all per-run resources are absent. No production data, snapshot or retention policy is deleted by this harness.

`finally` attempts teardown on partial failure, SIGINT and SIGTERM. Workflow recovery continues after a failed harness step, uploads the sanitized journal/packet, then a final hard gate checks both original acceptance and recovery outcomes. Runner loss, forced cancellation or a hard job timeout cannot execute an in-process finalizer. Download the journal and resume the exact approved source manually; no unattended-work or guaranteed-cloud-cleanup claim is made:

```bash
export PATH="$ZENITH_NODE22_BIN:$PATH"
ZENITH_LIVE_AWS=1 ZENITH_LIVE_AWS_BUDGET_USD="$AWS_ACCEPTANCE_BUDGET_USD" \
ZENITH_LIVE_SCOPE_FILE="$AWS_ACCEPTANCE_SCOPE_FILE" \
ZENITH_LIVE_AWS_SESSION_FILE="$AWS_ACCEPTANCE_SESSION_FILE" \
npx tsx scripts/acceptance/aws-live.ts --permissions "$AWS_ACCEPTANCE_PERMISSIONS_FILE" \
  --cleanup "$AWS_ACCEPTANCE_JOURNAL_FILE"
```

Cleanup preserves counters, plan/permission/source bindings and earlier failures. Exhausted counters require a newly reviewed recovery envelope; they cannot be reset by rerunning. A closed journal requires no calls. Atomic `journal.json` stores only intended families, bounded counters, a DNS resource identity and scoped managed-secret ARN, never raw AWS responses, secret values, tokens or plan state. `evidence.json` contains timestamps, source commit, plan/permission hashes, check scopes, cleanup result, visible pending rows and no false release promotion. Only the actual SDK transport can set live provenance; modeled transports cannot emit live requirement evidence even when a check claims success. Only complete independently verified product checks can produce ledger-shaped `live_sandbox` entries; fixture-only checks never do. The packet hash allows reviewers to bind the sanitized evidence artifact.

## Shared owner procedure, final integration

All L1/L2/L3 commands use one absolute `ZENITH_LIVE_BUDGET_FILE` below the owner private directory. Reservations are locked, cumulative across providers and never automatically refunded. A repeated run id is refused; use the cleanup-only command after interruption. Existing exact scope, permission, inventory and ownership gates remain mandatory. Cloud acceptance is deferred; none was executed by final integration.

### Azure, GCP, OCI and DNS live acceptance

Build packet for L2-LIVE-CLOUDS. No cloud, DNS, ACME, browser or paid action was executed on this PC. Offline tests model responses; they are contract evidence only. No requirement or release flag is promoted.

## Entry points and authority

`npx tsx scripts/acceptance/live/{azure,gcp,oci}/run.ts` and `npx tsx scripts/acceptance/live/dns/run.ts <provider>` are real entry points. They check Node 22, a clean checkout at the packet's exact commit, provider opt-in and an owner-approved `permissions.json` before opening credential files or making a request. DNS also needs `ZENITH_LIVE_DNS=1`. Missing opt-in exits 3 (NOT RUN); invalid configuration exits 2; failed/incomplete evidence exits 1. Exit 0 means the selected checks and scoped cleanup passed, never that an entire requirement is verified.

The owner supplies a permissions file matching `zenith.live-cloud-permissions.v1`. The example is deliberately unapproved and expired. It binds the parsed packet SHA256, cost/duration ceiling, expiry, exact HTTPS origins/path prefixes, DNS suffixes, retained bootstrap resource IDs and teardown targets. Changing any packet field invalidates approval. Every request and page rechecks permission. No inline token, ambient credential, privileged fallback, shell command or approval API is accepted.

Compose integration also requires the existing root scope approval, supplied through `ZENITH_LIVE_SCOPE_FILE` as a separate approved root manifest. Its strict schema and approval digest stay unchanged. The `non-aws-dns-live` observer grant must permit the selected provider read, control-plane read and owned teardown; the real destroy path still proves ownership and consumes human approval. Root per-run/per-provider/total budgets and lifetime ceilings apply alongside the exact L2 packet envelope, and root expiry is rechecked for subsequent calls. In particular the shipped OCI budget is zero and every shipped root approval is absent; a person must approve an appropriate envelope before any live campaign.

`--plan --packet <file>` opens only that non-secret packet. It prints scenario coverage, provisional estimate, dependencies and reverse cleanup order, with zero credential reads/network calls. Estimates must include managed DB/cluster minimum billing, egress, latency/residency constraints and orphan contingency; they are supplied by the Wave 5 cost/release packet emitter, not live price discovery. Budget alerts are notifications, not a hard spending cap.

## Operated fixture seam (Wave 5 join, explicit)

This base lacks the Wave 5 release/MAN fixtures. The harness does not reimplement their provisioning, authority, approval, fault injection or managed service code. The small join is `Packet` in `scripts/acceptance/live/dns/contracts.ts`: the release fixture producer emits one provider-scoped packet containing environment IDs in producer-before-consumer order, immutable operation/plan IDs, independent read URLs and exact JSON-pointer assertions. The person still approves fixture execution and destroy in the real browser. Until this packet is emitted from the operated fixture, the live scenarios cannot close acceptance.

Examples contain REPLACE fields and intentionally wrong commit/run IDs. They are plans, not executable proof. Replace every check's assertions with the full clause mapping below; asserting only a status is insufficient. Operations must return a bound terminal ID and environment; mixed plan reads reuse `verifyMixedEvidence`. New fault/materialization scenarios need separate operation receipts and independent readbacks; one happy-path receipt cannot cover failure scenarios.

| Requirement | Mandatory operated scenarios / independent readback |
|---|---|
| LIFE-04 | `azure-source-binding`: immutable source context digest and account/container provenance; `azure-data-plane`: exact scoped roles plus Blob/Key Vault read; `azure-source-build`: ACR run succeeded and image digest read independently; `azure-sovereign`: a separate sovereign-account packet proves its configured authority/ARM hosts. Public Azure does not satisfy sovereign acceptance. |
| LIFE-05 | `oci-runner-replacement`: kill/restart an owned runner inheriting the durable journal, same receipt/request/resource identity; `oci-lost-response`: lost launch stays uncertain, no second launch; `oci-deletion`: absent resource and complete family listing, work request only corroborates; `oci-mysql-refusal`: exact unsafe-secret-sink refusal. Fault injection belongs to the Wave 5/runner fixture, not this observer. |
| LIFE-06 | Per GCP/Azure/OCI: `dns-owned` reads exact record/endpoint tags, value, ownership marker and reviewed proof digest; `dns-foreign` and `dns-unreadable` require explicit ownership refusal (not cancellation/timeout) with no approvable destroy operation. Finally wait for exact human-approved destroy and independent empty record inventory. Foreign records remain unchanged. |
| MIX-01 | `mixed-authorities`: at least two provider/account/region/backend/connection identities independently observed. |
| MIX-02 | `mixed-immutable-plans`: parent approval and immutable child-set/subplan/semantics digests, dependency order, stable addresses, durable receipts, resume. |
| MIX-03 | `mixed-output-scope`: producer provenance, typed output/secret references, changed effect requires new review unless exact preauthorization. Never put secret values in the packet. |
| MIX-04 | `mixed-failure-order`: separate cycle, partial success, timeout, expiry, cancellation, outage, drift, migration and reverse-teardown observations; no automatic destructive compensation. |
| MIX-05 | `mixed-connectivity`: actual protected/private routes, CIDR overlap refusal, DNS/TLS/identity/secret binding, independent firewall/private endpoint readback. Database public exposure is never silently accepted. |
| MIX-06 | `mixed-traffic`: protected fixture endpoint returns the supplied fresh nonce after a DB write/read through actual GCP compute, Azure PostgreSQL and AWS functions, with independent provider/DB readbacks. The AWS job supplies its partition evidence; a renamed local/mock tier is insufficient. |
| MIX-07 | `mixed-recovery-economics`: fixture injects one-provider outage and recovery, independently probes traffic before/after; read measured transfer/latency/residency and catalog economics. |
| MAN-01 | `managed-substrate`: default composition/session opener, owned source build and release, actual managed cluster/provider state and traffic; no injected mock ports. |
| MAN-02 | `managed-serving`: each registry/gateway/DNS/TLS/secret/storage/DB integration has a real readback. |
| MAN-03 | `domain-proof-renewal`: DNS TXT proof plus a renewed certificate on a trusted TLS socket, exact hostname, validity and changed issuer/serial/expiry readback from the operated ACME renewal; `managed-data-catalog`: tenant storage separation, DB export/restore nonce, autoscaling and promised catalog services. |
| REL-01/02/04 | Evidence, budgets, scope, cleanup and checkpoint support only. Complete release journey/dossier/signoff remains the release job's scope. OPS and MAN-04..07 remain with their owners. |

## Credentials and bootstrap

Keep every file outside the checkout, mode 0600, and never upload it as evidence. `ZENITH_LIVE_API_TOKEN_FILE` contains the control-plane integration token. `ZENITH_LIVE_<PROVIDER>_CREDENTIAL_FILE` names a JSON file:

- Azure: `{provider:"azure", account:<subscription>, region:<region>, tokenFiles:{<exact HTTPS origin>:<token FILE path>}}`. Obtain audience-specific short-lived Entra tokens through the approved GitHub environment federation. ARM, Blob, Vault and ACR tokens have separate audiences. Blob XML readback exposes HTTP status/content hash only.
- GCP: `{provider:"gcp", account:<project ID>, region:<region>, accessTokenFile:<short-lived impersonated token FILE>}`.
- OCI: `{provider:"oci", account:<compartment OCID>, region:<region>, securityTokenFile:<short-lived RPST FILE>, privateKeyFile:<ephemeral PoP private-key FILE>}`. Requests use standard OCI RSA-SHA256 signatures. No user API key is accepted.

All three credential references may additionally specify `trafficTokenFiles:{<approved exact HTTPS origin>:<application bearer token FILE>}` for protected fixture traffic. Cloud and control-plane credentials are never reused for application endpoints. Private-network-only endpoints may omit it.

`deploy/live-sandbox/<provider>/main.tf` creates scoped observer trust/roles and 50% actual/80% forecast monthly budget alerts. Observer credentials have no deploy/destroy/IAM management authority; provisioning stays with the existing reviewed Zenith connection and browser policy. All application resources need `zenith_live_run=<run ID>` in Azure tags, GCP labels and OCI freeform tags, alongside existing Zenith workspace/environment ownership metadata. Label/tag creation is a fixture-emitter join; this job does not add tag adoption to production callers.

Azure federation pins the exact repository/protected environment subject. GCP additionally pins numeric owner/repository IDs and ref. OCI uses an IdentityPropagationTrust template with five exact claim validations; the owner must configure the non-admin exchange client or an approved instance-principal caller. Token exchange itself still requires caller authentication; this is not an anonymous GitHub-to-OCI exchange. No admin client fallback. OCI policy condition names and service permissions require actual provider/tenancy admission before use; do not infer it from HCL syntax.

Primary references: [Microsoft federation trust](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust), [Google pipeline federation](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines), [OCI JWT-to-RPST trust and authenticated exchange](https://docs.oracle.com/en-us/iaas/Content/Identity/api-getstarted/token_exchange_grant_type_workload_id-federation.htm).

## Inventory, teardown and evidence

Supply complete service-specific inventories of every created family. Azure RG resource lists omit registry images and some child DNS records, so add those inventories. GCP assets can be eventual and do not replace complete Compute/DNS/Storage/Artifact Registry lists. OCI lists each created family within the exact compartment, including DNS record sets and Object Storage objects. GCP zonal Compute `items` may be absent for an empty list: set `emptyListKind: "compute#instanceList"` only for that documented API; an unrecognized object is never interpreted as zero resources. Typed-empty descriptors use `/items` for Compute/Storage, `/rrsets` for Cloud DNS record sets, and `/managedZones` for Cloud DNS zones. Confirm the DNS response-kind literals against the real Mac readback before acceptance. GCP inventory URLs must omit response masks, grouping and partial-success flags; unreachable resources refuse completion. Storage object lists may use `emptyListKind: "storage#objects"`; the runner rejects nonempty grouped prefixes, so use a flat, unfiltered listing of all owned versions. See [Google Storage objects list](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/list). Each inventory specifies items/id/tags JSON pointers and provider pagination. Retained bootstrap IDs must be individually reviewed. DNS record sets and registry images without their own tags use `parentOwnership`: independently read the parent's run tag and require the child ID prefix or exact DNS target values to match its current owned endpoint. DNS A/CNAME records need the value binding, not merely a zone name. Raw unbound children refuse cleanup. The real control-plane destroy path still performs its own ownership/proof/approval checks.

Cleanup runs in `finally`, reverse environment order. It requests the existing read-only teardown review, waits for a person and requires consumed approval plus the bound destroy result. Failed consumer cleanup stops destructive producer cleanup. All configured inventories are scanned regardless; pagination, duplicates, unreadable/foreign resources and permission expiry fail closed. Leak scans retry 12 times (5 seconds apart). Credentials revoked, SIGKILL, permission expiry, absent human approval or unavailable services can prevent physical cleanup; there is no false guarantee. The owner must retain the same packet and run `--cleanup` after restoring authority. SIGINT/SIGTERM requests bounded cleanup. No raw provider errors, tokens, bodies or credential paths enter evidence.

Evidence has ledger-compatible `level`, `commit`, `environment`, `result` plus selected requirement/check IDs, parsed packet digest and cleanup counts. Keep the private packet alongside the evidence locally. Artifact path is attached by the verifier when adding a ledger record. Never write `verified`, count NOT RUN as passed, or use selected probes as whole-requirement proof.

## Exact Mac campaign

Node 22; macOS ARM64, 8 GiB RAM, Docker 4 GiB. Run one provider/fixture at a time, one worker, two tiny application replicas at most, bounded 1-hour exercise plus cleanup authority. Use the operated Wave 5 default API/worker/runner installation; its owner supplies the canonical startup command after integration. No Docker/Temporal/kind/browser/cloud startup is performed by this runner. That unresolved startup/packet join is recorded, not substituted with mocks.

Offline checks (no cloud prerequisites):

```bash
node --version # 22.x
npx vitest run --config scripts/acceptance/live/dns/vitest.config.ts scripts/acceptance/live/dns/offline.test.ts --no-file-parallelism --maxWorkers=2
npx eslint scripts/acceptance/live
for p in azure gcp oci; do
  npx tsx "scripts/acceptance/live/$p/run.ts" --plan --packet "scripts/acceptance/live/$p/packet.json.example"
done
```

Expected: offline tests pass with zero skips; all plans report zero credential reads/network calls. The denied permission example cannot start a live run.

Provider validation (Mac, no apply, no credentials; downloading pinned provider packages is separate from cloud acceptance):

```bash
for p in azure gcp oci; do
  tofu -chdir="deploy/live-sandbox/$p" init -backend=false
  tofu -chdir="deploy/live-sandbox/$p" validate
done
tofu fmt -check -recursive deploy/live-sandbox
```

Expected: all modules validate with initialized providers. Retain failure diagnostics; HCL validation does not prove live IAM syntax, permission propagation or budget delivery. Owner bootstrap/apply is a separate approved action, never implied by these commands.

Only after accountable live approval and operated fixtures exist, freeze the clean integrated commit. Store packet, token references, permissions and new evidence paths outside the checkout. Set the environment names in the credential section; use one provider at a time:

```bash
export ZENITH_LIVE_AZURE=1 # or ZENITH_LIVE_GCP=1 / ZENITH_LIVE_OCI=1
export ZENITH_LIVE_API_TOKEN_FILE="$HOME/.zenith-live/api-token"
export ZENITH_LIVE_SCOPE_FILE="$HOME/.zenith-live/approved-root-scope.json"
export ZENITH_LIVE_AZURE_CREDENTIAL_FILE="$HOME/.zenith-live/azure-credential-ref.json"
npx tsx scripts/acceptance/live/azure/run.ts --packet "$HOME/.zenith-live/azure-packet.json" --permissions "$HOME/.zenith-live/permissions.json" --out "$HOME/.zenith-live/azure-evidence.json"
# Same flags and provider-specific credential FILE variable for gcp/run.ts and oci/run.ts.
export ZENITH_LIVE_DNS=1
npx tsx scripts/acceptance/live/dns/run.ts azure --packet "$HOME/.zenith-live/dns-azure-packet.json" --permissions "$HOME/.zenith-live/dns-permissions.json" --out "$HOME/.zenith-live/dns-azure-evidence.json"
# Resumable cleanup, exact original packet, reviewed renewed permission and new output:
npx tsx scripts/acceptance/live/azure/run.ts --cleanup --packet "$HOME/.zenith-live/azure-packet.json" --permissions "$HOME/.zenith-live/permissions.json" --out "$HOME/.zenith-live/azure-cleanup-evidence.json"
```

Expected: selected complete checks report passed_live, all human-approved teardown operations succeed, and every independently queried inventory is empty except individually retained bootstrap IDs. Missing probes, sovereign prerequisite, Wave 5 join, consent or read authority means incomplete/failed, never verified.

The gated Vitest successor is optional orchestration of those same entry points:

```bash
export ZENITH_LIVE_AZURE_PACKET_FILE="$HOME/.zenith-live/azure-packet.json"
export ZENITH_LIVE_PERMISSIONS_FILE="$HOME/.zenith-live/permissions.json"
export ZENITH_LIVE_AZURE_EVIDENCE_FILE="$HOME/.zenith-live/azure-vitest-evidence.json"
npx vitest run --config scripts/acceptance/live/dns/vitest.config.ts scripts/acceptance/live/dns/clouds.live.test.ts --no-file-parallelism --maxWorkers=2 -t "live azure"
```

For GCP/OCI replace the three AZURE variables and test filter. DNS uses `ZENITH_LIVE_DNS_PROVIDER`, `ZENITH_LIVE_DNS_PACKET_FILE`, `ZENITH_LIVE_DNS_EVIDENCE_FILE` and filter `live DNS/ACME`. Unselected or ungated tests are explicitly skipped, not passed; inspect counts separately from the standalone receipt.

## Integration and remaining work

The assembler joins the Wave 5 packet emitter, existing permissions envelope and run-tag insertion, registers this custom offline config/gated file in gate manifest, and adds artifact records on the final coherent commit. Existing provider/core/installer/migrations/dependencies/workflows are untouched. No new table or tenancy/inventory classification is needed. Ledger rows touched retain evidence/history and receive implementation_complete_verification_pending with a harness-slice note; no whole-requirement completion is claimed.

### L3 managed, mixed-cloud and release live acceptance

Builder base: `443bfeaf`. This document describes an owner-gated harness, not performed cloud verification. No cloud was called on the Windows builder. `live_sandbox`, `operational_rehearsal` and production signoff remain pending. Acceptance text in `ledger.json` is authoritative; a successful observation is not verification of its entire requirement.

## Entry points and evidence

| Profile | Entry point | Gate | Required scenario catalogue |
| --- | --- | --- | --- |
| Managed | `bash scripts/acceptance/managed-acceptance.sh` | `ZENITH_LIVE_MANAGED=1` | MAN-01 through MAN-07 |
| Mixed | `bash scripts/acceptance/live/mixed/acceptance.sh` | `ZENITH_LIVE_MIXED=1` | MIX-01 through MIX-07 |
| Release | `bash scripts/acceptance/live/release/acceptance.sh` | `ZENITH_LIVE_RELEASE=1` | All required REL-01 journeys and nine OPS rehearsals |

All three call `scripts/acceptance/live/managed/cli.ts`. Strict recipe validation, plan hashing, the existing `scripts/release/scope.ts`, exact-plan approval, journal and budget reservations are in `plan.ts` and `runner.ts`. `transport.ts` contains actual HTTPS, Kubernetes API and AWS/GCP/Azure inventory calls. `mixed/probes.ts` reuses the existing reference traffic generator, independent price/checksum checker and protected-connectivity checker, and adds TLS peer verification to the direct PostgreSQL readback. Nothing falls back to a mock transport in the CLI.

An owner writes a recipe of specific requests and expected JSON-pointer observations. The engine does not invent these from a model or from expected test results. Each step has a stable id, scenario, scope action, exact target, resource binding when it changes anything, attempt count and interval. Assertions compare JSON values without coercion; a missing field never satisfies `null`. HTTP responses, database rows, cookies, kubeconfig, credentials and provider error text are omitted from public evidence. The recipe itself must contain no secret values: use credential FILE references and product vault references. Sanitization cannot recognize every unknown secret; public evidence uses a fixed output schema instead.

Every scenario id is enumerated by `scenarios(profile)` in `plan.ts`. Missing scenarios remain in `pendingScenarios`. Exit codes: `0` all selected profile observations, cleanup and inventories passed with no pending scenarios; `1` at least one performed check failed; `2` gate/plan/fixture/permission refusal; `3` incomplete profile or cleanup-only completion. Skips, incomplete recipes and cleanup-only runs are never live passes. Evidence is `.data-live/l3/<runId>/report.json`, `journal.json` and, on recovery, `cleanup-report.json`; these are ignored by Git. Results bind the exact source commit, scope digest and recipe digest. No ledger verification flag is set by this tool.

## Owner prerequisites and approvals (DEC-CLOUD)

The owner, not the harness, must provide:

1. Disposable sandbox accounts/projects/subscriptions, exact regions and an existing managed EKS/GKE/AKS/OKE or equivalent cluster. Provisioning, IAM changes, cluster/node-pool creation, production resources, account creation, purchases and accepting terms are outside this harness. Use the normal Zenith installation and browser approval paths for provisioning and source build/release; point observations at their actual operation ids. MAN-01 must use the default composition with no injected test ports.
2. A running sandbox Zenith control plane, real PostgreSQL platform/product stores and Temporal worker/server. For a lean Mac run, use the already operated remote disposable sandbox and cloud cluster. The L3 observer then needs only Node 22 and its existing dependencies, no Docker. Do not boot the full default stack, kind, PostgreSQL and Temporal concurrently on the 8 GB Mac/4 GiB Docker allocation. Local rehearsals below run sequentially against one disposable stack; obtain J1's resource profile after integration rather than guessing unsupported flags.
3. A private GitHub App installation/repository and approved immutable private-source snapshot for source journeys; private registry with real pinned images/provenance; an owned DNS subdomain and DNS write authority through the product, a real ACME issuer/renewal path, gateway and managed object storage/database. These fixtures need owner creation and authorization. Real ACME and registry checks are distinct from local pebble/registry tests.
4. Two disposable tenants, an enforcing CNI (Cilium for FQDN egress), a sandbox RuntimeClass/node pool (J14), limits and an explicitly reviewed noisy-neighbour load bound. Do not disable assertions or substitute namespaces for isolation. Record provisional load/SLO bounds and exact environment.
5. Stripe **test mode** account/customer/webhook setup for MAN-06. Do not change real billing or charge a customer. MAN-07 pricing/terms remain provisional (DEC-BUSINESS); suspension must preserve data and permit export. Destructive retention needs DEC-RETENTION, is outside these recipes, and stays disabled. Production release signing/signoff need their separate owner decisions; this harness grants neither.
6. For mixed traffic: GCP web compute, Azure PostgreSQL, AWS enricher/function, real protected network/TLS/identity/secret bindings and separate approved partition connections/backends. An equivalent placement needs a written owner-reviewed justification; row markers alone do not establish provider identity. Independently observe actual provider resources/receipts as well as the direct database readback.
7. Protected-endpoint probes from **both** an allowlisted and an outside-allowlist machine, with the valid client certificate, key and CA files. One vantage point cannot prove both access and denial. Include both observations in the campaign dossier; one successful recipe is not complete MIX-05 evidence.
8. Genuine owner/browser session cookie FILE for browser-only routes (including prior MFA step-up when required), scoped bearer token FILE for reads, static short-lived kubeconfig FILE, temporary AWS credential JSON FILE, GCP/Azure access token FILEs and read-only PostgreSQL URI/CA FILEs as applicable. Files must be absolute, private regular files (0600 on macOS); no ambient credential chains, exec/auth-provider kubeconfig plugins, metadata credential fallback or TLS bypass. Kubeconfig embeds CA and optional client certificate/key data; its exact context and server must match the plan.
9. Review and approve budget/grants using the existing interactive permissions CLI. `permissions.json` ships unapproved, and **does not currently grant managed/release mutations**. `--plan` emits a proposed grant to review; the integrator/owner adds the grant to an owner-local manifest and approves its digest. The builder does not edit or approve that file. Managed uses `managed-acceptance-live`, mixed uses `mixed-traffic-live`, release uses `release-acceptance-live`. Mixed fault injection also requires `inject_fault` and any cluster provider grant; the shipped mixed grant does not include them.
10. A separate exact-plan approval FILE, described below, and a shared absolute budget FILE for L1/L2/L3 reservations. Explicit price projection must include the run window of pre-existing resources, egress, storage, idle time and cleanup. Every cloud provider needs a positive projection; reserve is allocated proportionally when checking provider caps. Bundled placeholder prices are never executable.

## Exact Mac commands

Start from the clean, committed integrated verifier RC, Node 22 and existing node_modules. Do not install dependencies as part of this harness. Owner creates a private working directory outside the checkout:

```bash
node --version                             # must be v22.x
umask 077
export L3_PRIVATE="$(mktemp -d "${TMPDIR:-/tmp}/zenith-l3-owner.XXXXXX")"
bash scripts/acceptance/managed-acceptance.sh --template > "$L3_PRIVATE/managed.recipe.json"
bash scripts/acceptance/live/mixed/acceptance.sh --template > "$L3_PRIVATE/mixed.recipe.json"
bash scripts/acceptance/live/release/acceptance.sh --template > "$L3_PRIVATE/release.recipe.json"
# Owner edits recipes: actual targets/ids, tagged resources, assertion matrix below,
# timestamps, full price projection, approved cleanup, all independent inventories.
bash scripts/acceptance/managed-acceptance.sh --plan --fixture "$L3_PRIVATE/managed.recipe.json" > "$L3_PRIVATE/managed.plan.json"
bash scripts/acceptance/live/mixed/acceptance.sh --plan --fixture "$L3_PRIVATE/mixed.recipe.json" > "$L3_PRIVATE/mixed.plan.json"
bash scripts/acceptance/live/release/acceptance.sh --plan --fixture "$L3_PRIVATE/release.recipe.json" > "$L3_PRIVATE/release.plan.json"
```

These commands read neither credential FILEs nor a cloud. Templates are deliberately incomplete and use `.invalid` targets; execution refuses them. Template generation itself is not readiness evidence. Fill all scenarios, rather than repeating the same operation-status assertion under different scenario ids.

The owner creates `$L3_PRIVATE/permissions.json` from the reviewed manifest, adds only needed proposed grants within the existing per-run/per-provider/total/TTL budgets, and approves it interactively:

```bash
export ZENITH_LIVE_SCOPE_FILE="$L3_PRIVATE/permissions.json"
npx tsx scripts/release/permissions-cli.ts show
npx tsx scripts/release/permissions-cli.ts approve --by 'Arnav Bule'
npx tsx scripts/release/permissions-cli.ts check
```

Then rerun each `--plan` command with that scope. The owner writes a private exact-plan approval JSON per recipe (no secret, no automatic approval). Fields must be actual values from that plan and manifest, not the placeholders below:

```json
{
  "schema": 1,
  "decision": "DEC-CLOUD",
  "approvedBy": "Arnav Bule",
  "approvedAt": "<actual approval ISO timestamp>",
  "expiresAt": "<actual ISO timestamp covering the run plus cleanup>",
  "planSha256": "<plan.sha256>",
  "scopeDigest": "<permissions-cli digest>",
  "sourceCommit": "<integrated verifier RC SHA>"
}
```

Store cookies/tokens/kubeconfig via the owner's authenticated tooling, never in recipes or shell literals. Export only FILE references (recipe `credentialRef`, `caRef`, `certRef`, `keyRef` name these env variables). Example profile invocation, after all prerequisites and exact approval:

```bash
export ZENITH_L3_BROWSER_FILE="$L3_PRIVATE/browser.cookie"
export ZENITH_L3_KUBECONFIG_FILE="$L3_PRIVATE/kubeconfig"
export ZENITH_L3_BUDGET_FILE="$L3_PRIVATE/budget.json"
export ZENITH_L3_OUT="$PWD/.data-live/l3"
export ZENITH_L3_APPROVAL_FILE="$L3_PRIVATE/managed.approval.json"
ZENITH_LIVE_MANAGED=1 bash scripts/acceptance/managed-acceptance.sh --run --fixture "$L3_PRIVATE/managed.recipe.json"

export ZENITH_L3_APPROVAL_FILE="$L3_PRIVATE/mixed.approval.json"
ZENITH_LIVE_MIXED=1 bash scripts/acceptance/live/mixed/acceptance.sh --run --fixture "$L3_PRIVATE/mixed.recipe.json"

export ZENITH_L3_APPROVAL_FILE="$L3_PRIVATE/release.approval.json"
ZENITH_LIVE_RELEASE=1 bash scripts/acceptance/live/release/acceptance.sh --run --fixture "$L3_PRIVATE/release.recipe.json"
```

Run **once per recipe/run id**. No forward effects are automatically resumed. Gated vitest alternative (choose one profile; do not first run the same recipe via its shell):

```bash
export ZENITH_L3_MANAGED_RECIPE_FILE="$L3_PRIVATE/managed.recipe.json"
ZENITH_LIVE_MANAGED=1 npx vitest run tests/acceptance/live-l3.gated.test.ts --no-file-parallelism --maxWorkers=1
# For mixed/release, use ZENITH_L3_MIXED_RECIPE_FILE or ZENITH_L3_RELEASE_RECIPE_FILE,
# the matching profile gate and exact-plan approval FILE. Other profiles are SKIPPED.
```

Expected: active profile has 1 actual passing live test only when its CLI exits 0; two other profiles explicitly skip. Without gates all 3 skip and establish no live evidence. Recipe counts depend on the reviewed observation matrix, and the JSON report provides exact performed/failed/not-run counts. A runtime failure always attempts every reviewed cleanup entry and every independent inventory. Handle SIGINT/SIGTERM by letting the current bounded call settle and cleanup finish. SIGKILL/power loss cannot execute `finally`.

## Required observation matrix

Owner recipes must map **each acceptance clause** to concrete normal-product receipts and independent resource/traffic observations. `http` and `kubernetes` steps support exact JSON-pointer expectations and bounded polling. Use `{ "pointer": "/p95Ms", "min": 0, "max": 500 }` for a finite measured bound, or `equals` for exact JSON equality; never both. Missing, nonnumeric or nonfinite measurements fail. They do not manufacture operational rehearsal evidence. The release profile requires all 16 existing REL-01 scenario ids plus these nine OPS rehearsal ids. Use new ids for each distinct check.

| Rows | Required real observations |
| --- | --- |
| MAN-01 | Default session/tenant identity and refused cross-tenant access; immutable private source/build isolation/provenance and registry digest; real release ready pods and serving health. Never use the legacy kind fixture's synthetic next digest as a real successful release. |
| MAN-02/03 | Registry pull/readback, Gateway/route, issued certificate SAN/issuer/expiry and real TLS; vault secret delivery without exposing it; tenant object storage positive/negative access; managed DB identity; DNS proof, renewal/revocation; export/restore content checksums; HPA metrics/load and catalog capability readback. |
| MAN-04/05 | Two tenants with positive controls plus route/storage/CNI/metadata/FQDN egress/pod-security/quota/operator denial; sandbox RuntimeClass actually running; CPU/memory/disk/PID exhaustion and measured victim p95 within recorded provisional bounds. A configuration object alone is insufficient. |
| MAN-06/07 | Real Stripe test invoice/event reconciliation and idempotent replay; plan assignment, meter/quotas; BYOC without billing; suspension refuses new work while preserving row/resource counts and allowing export; reinstatement. Pricing/terms and destructive retention stay undecided. |
| MIX-01/02 | `mixed_evidence` request to the real stored plan verifies separate accounts/connections/backends, immutable child/semantics digests, durable receipts, dependency order and stable addresses. Independently read actual child resources; stored receipts alone do not prove provider reality. |
| MIX-03/04 | Typed output provenance/scope, sealed references, changed materialization demands review; cycles and missing authority refused; partial success/timeout/expiry/cancel/outage/drift/migration block safely; no destructive compensation. Capture real operation/refusal receipts and reverse-order destroy release/sync. |
| MIX-05 | `connectivity` request pins endpoint hostname, DNS targets, TLS minimum, SPKI, valid mTLS material, approved allowlist. Include both vantage points. Verify actual route/firewall/private endpoint and overlap handling separately. Database public exposure cannot be silently accepted. |
| MIX-06 | `mixed_traffic` baseline and recovered requests: GCP entry, Azure direct PostgreSQL TLS read-only transaction, AWS enricher markers and actual cloud resource reads. Checker recomputes price/checksum, rejects missing/duplicate/phantom/rejected rows and checks idempotent replay. No app readback endpoint is accepted. |
| MIX-07 | `scale_deployment` for an exact tagged disposable GCP Kubernetes-equivalent Deployment (zero replicas requires `inject_fault`); observe outage and direct DB uncertain writes, then restore replicas and observe readiness/traffic. Owner documents equivalence. Other compute fault modes require owner-operated real fault and heal plus independent observations. Read actual economics response with priced transfer/residency/latency terms; prices are estimates, not invoices. |
| OPS-01 | `slo-measurement`: measured availability/latency/capacity and restore-derived RPO/RTO; objective approval remains provisional unless separately signed off. |
| OPS-02 | `control-plane-outage-fairness`: actual outage and read-only maintenance receipts, tenant queue/backpressure/fairness measurements, serving independent workload, correlated dashboards/alerts successfully imported. |
| OPS-03 | `rolling-upgrade-replay`: actual in-flight histories across N-1/N API/worker/runner, replay result, compatibility refusal and rollback readback. |
| OPS-04 | `clean-host-restore`: fresh host/store identities, restored stores/artifacts/Temporal/customer state, consumed approvals refuse reuse and old epoch refuses writes until explicit reconciliation/reopen. |
| OPS-05 | `key-rotation-decrypt-history`: purpose ids, active/decrypt-only states, old ciphertext/history remains readable, wrong-purpose refusal and real KMS/HSM audit receipts where claimed. Never expose material. |
| OPS-06/07 | `persistence-leak-scan` of operated stores/logs/history with runtime canaries; `archive-hold-dry-run` sealed object verify/restore/hold and preview counts. No deletion or general perfect-redaction claim. |
| OPS-08 | `independent-adversarial`: independent reviewer/tester performs tenant/role/stale approval/SSRF/rebinding/prompt/archive/build/exfiltration/forgery/escalation/integration-compromise probes against the operated stack/cloud metadata surfaces. This builder's offline tests are not independent acceptance. |
| OPS-09 | `signed-release-audit`: independently verified real artifacts/SBOM/provenance/updater signature/triage/audit chain. Local ephemeral signing key is rehearsal only; actual tag release needs the separate signing-key decision. |
| REL-01 | All existing required scenario ids: install, private-source, plan-approval, dns-tls, stateful-traffic, update-rollback, machine-schedules, drift-repair, revocation, crash-partition, rotation, upgrade, restore, two-tenants, export, teardown. Include their actual operational receipts and independent cloud traffic/readback. |
| REL-02/03/04 | Generate dossier at exact RC, retain pending/skipped entries and full environment; no automatic production signoff; exact digest/target/budget approval and conservative attempted-effect journal with next cleanup command. |

## Tagging, cleanup and inventory limitations

Tag owned resources during their normal disposable provisioning. Do not stamp a tag on an unrelated object to make cleanup pass. Canonical cloud tags/annotations are `zenith:live-run=<runId>` and `zenith:ttl-expires=<startedAt + ttlMinutes ISO>`. Kubernetes also needs label `zenith.dev/live-run=<runId>`; GCP uses label `zenith_live_run=<runId>` because colon keys are not supported. Independent ownership reads must match exact run and TTL plus the pinned pointer assertions before any mutation/delete. Namespace deletion uses live UID and resourceVersion preconditions, never `--all` or a wildcard name. Deployment scale uses live identity/resourceVersion and exact replicas; approved cleanup can restore its declared baseline before namespace teardown. This is preauthorized fixture cleanup, never automatic mixed compensation.

Mixed teardown POSTs can **only release/sync already human-approved child destroy operations** at the existing browser-only route. Include their terminal status polling and sync steps in dependency order before inventories. The harness cannot propose a new approval or release an unapproved destroy operation. Missing, stale, expired or revoked approvals yield failure, including during cleanup; no expiry bypass exists. Approve a cleanup window longer than the run TTL.

Independent scans check Kubernetes namespaces/PVs/ClusterRoles/ClusterRoleBindings bearing the run label; AWS Resource Groups Tagging API (with independently checked STS account and explicit commercial-region endpoints); GCP Cloud Asset Search within exact project; Azure resource inventory within exact subscription. Cloud scans paginate with bounded calls and reject unreadable or incomplete responses. K8s inventories reject continuation tokens rather than declaring an incomplete page empty. AWS/GCP/ARM tag indexes can lag or omit unsupported/global/untaggable resources; zero here covers the **declared indexed inventory only**. Add provider-specific direct reads for every provisioned kind, including volumes, DNS, registry images and global IAM, via L1/L2 and the owner campaign. An empty generic tag index alone is insufficient for the ledger's full zero-leak acceptance. OCI inventory is refused, not approximated.

On interruption, use the **same** committed checkout, recipe, source digest, scope, credential refs and original out directory. Investigate a crash `run.lock` before removing that specific lock; the tool never silently steals a lock. Retry cleanup, not forward effects:

```bash
ZENITH_LIVE_MANAGED=1 bash scripts/acceptance/managed-acceptance.sh --cleanup-only --fixture "$L3_PRIVATE/managed.recipe.json"
ZENITH_LIVE_MIXED=1 bash scripts/acceptance/live/mixed/acceptance.sh --cleanup-only --fixture "$L3_PRIVATE/mixed.recipe.json"
ZENITH_LIVE_RELEASE=1 bash scripts/acceptance/live/release/acceptance.sh --cleanup-only --fixture "$L3_PRIVATE/release.recipe.json"
```

Cleanup-only success exits 3 (scenarios remain not run). A failed teardown or nonempty/unreadable inventory exits 1 and requires owner remediation. All entries are attempted even after an earlier cleanup fails. Budget reservations remain conservatively charged after cleanup and are never auto-refunded. Retain evidence and budget book until the owner reconciles actual spend and scans every supported resource kind.

## Local Mac verification and integration joins

Offline Windows/Mac contract commands:

```bash
ZENITH_LIVE_MANAGED=0 ZENITH_LIVE_MIXED=0 ZENITH_LIVE_RELEASE=0 npx vitest run tests/acceptance/live-managed.test.ts tests/acceptance/live-managed-transports.test.ts tests/acceptance/live-l3.gated.test.ts tests/release/live-scope-coverage.test.ts --no-file-parallelism --maxWorkers=2
npx eslint scripts/acceptance/live/managed scripts/acceptance/live/mixed/probes.ts tests/acceptance/live-managed.test.ts tests/acceptance/live-managed-transports.test.ts tests/acceptance/live-l3.gated.test.ts
bash -n scripts/acceptance/managed-acceptance.sh
bash -n scripts/acceptance/live/mixed/acceptance.sh
bash -n scripts/acceptance/live/release/acceptance.sh
```

Mac local-engine/cluster rehearsal commands (sequential, one worker; not run here):

```bash
# Start the reviewed J1 disposable default stack after that job integrates; its
# up.mjs owns readiness/labels. If its lean profile cannot fit, use the remote
# operated sandbox for L3 rather than weakening the install acceptance.
node scripts/acceptance/default-stack/up.mjs

# Owner sets digest-pinned registry/builder images in the environment first.
bash scripts/k8s/managed-substrate-acceptance.sh
# Run a separate cluster for Cilium/FQDN/runtime/load tests; review J11/J14 pins.
bash scripts/isolation/tenant-isolation-acceptance.sh kind-cilium

# With the owned PostgreSQL URL and Temporal endpoint set by the stack runbook:
ZENITH_TEST_PLATFORM_PG_URL="$OWNED_PLATFORM_PG_URL" npx vitest run tests/controlplane/mixed-parent-plans.test.ts tests/controlplane/mixed-runs.test.ts --no-file-parallelism --maxWorkers=1
ZENITH_TEST_TEMPORAL=1 npx vitest run tests/workflows/mixed-parent.test.ts --no-file-parallelism --maxWorkers=1
npm run replay:check
npm run ops:upgrade
# Recovery/retention/key commands and environment are in per-row existing docs;
# use their owned backup/restore configuration, never a production connection.
npx tsx scripts/release/acceptance-orchestrator.ts run --out .data-live/release-local
npx tsx scripts/release/dossier.ts --out .data-live/release-dossier.md --json .data-live/release-dossier.json
```

Original per-requirement verify documents retain precise engine/ops environment requirements. Legacy `managed-kind.test.ts` establishes object/build contracts, **not** running a real next release digest, platform DB/Temporal, cloud DNS/ACME, or paying tenants. The local isolation suite currently refuses non-kind contexts and is not quietly reused on a cloud cluster. Full default-journey/isolation/ops receipt producers must come from J1/J2/J4/J5/J6/J11/J14/J15 and the verifier campaign; L3 consumes genuine observations rather than injecting replacements.

The merged tree provides AWS-specific L1 plan/Guard/Transport/ProductScenarioPort contracts alongside the L2 and L3 runners. This job defines its helper under `live/managed` and shares the existing release Scope/digest and MIX checker interfaces. Final integration shares the conservative budget-book schema/lock, exact tag checks, absence checks and teardown helpers in `scripts/acceptance/live/shared.ts` across L1/L2/L3. Separate exact-plan approval FILEs retain the strict root Scope schema. Owner-reviewed managed/release grants and actual product observations remain prerequisites; no fixture observation promotes a product requirement. J12 remains owner of dossier/signoff status logic. No schema/migration need, package/lock changes or published SQL edits in L3.
