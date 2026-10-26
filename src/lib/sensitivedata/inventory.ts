/**
 * Sensitive persistence inventory (PROD-OPS-06).
 *
 * Every table, and every column that can plausibly hold sensitive data, with what it can hold, how it is
 * protected, how long it lives and how sure we are. The inventory is data, and a test (tests/security/
 * sensitive-inventory.test.ts) keeps it honest in both directions: a table or sensitive-looking column that
 * exists in the migrations but not here fails the suite, and an inventory entry for something that no longer
 * exists fails too. So new persistence cannot arrive unclassified.
 *
 * What the words mean (and do not):
 *  - `sealed`           the stored value is AES-GCM ciphertext under a registered key purpose. This is the only
 *                       protection that holds for a secret of any shape.
 *  - `write-guarded`    the repository refuses KNOWN credential shapes (assertNoSecretValues / assertNoSecretKeys)
 *                       or the writer redacts them. Best effort: a secret with no recognisable shape is stored
 *                       as given. Nothing here claims otherwise.
 *  - `digest-only`      a hash or digest is stored, never the value.
 *  - `tenant-content`   customer data by nature (app records, manifests). Protected by access control, not
 *                       encrypted by Zenith.
 *  - `host-protected`   plaintext on a worker's private volume, mode 0700, short-lived; the operator encrypts the
 *                       volume.
 *  - `none-needed`      the column cannot hold sensitive data by construction (ids, statuses, counts).
 *
 * `assurance` says how the claim is backed: `tested` (named test), `design` (named code control, no dedicated
 * test), `unreviewed` (inventoried and classified from its migration only; open follow-up).
 */
import type { KeyPurpose } from "@/lib/keycustody/purposes";

export type DataClass =
  | "secret"
  | "credential-derived"
  | "raw-plan-or-state"
  | "tenant-content"
  | "personal-data"
  | "operational";

export type Protection =
  | { kind: "sealed"; scheme: SealScheme; purpose: KeyPurpose }
  | { kind: "write-guarded"; guard: string }
  | { kind: "digest-only" }
  | { kind: "tenant-content"; note: string }
  | { kind: "host-protected"; control: string }
  | { kind: "none-needed"; reason: string };

export type SealScheme =
  | "vault-columns"
  | "result-box"
  | "plan-columns"
  | "opaque-bytes"
  | "temporal-envelope"
  | "backup-container";

export type Assurance = "tested" | "design" | "unreviewed";

export type Retention =
  | { policy: "ledger"; note: string }
  | { policy: "expiring"; note: string }
  | { policy: "minimized"; by: "data-minimize"; note: string }
  | { policy: "settle-erase"; note: string }
  | { policy: "immutable"; note: string }
  | { policy: "customer-controlled"; note: string }
  | { policy: "operational"; note: string };

export interface ColumnSink {
  protection: Protection;
  classification?: DataClass;
  assurance: Assurance;
  note?: string;
}

export interface TableSink {
  /** the module or requirement that writes it */
  owner: string;
  /** the strongest class the table can hold */
  classification: DataClass;
  retention: Retention;
  /** one line: why it exists */
  purpose: string;
  /** every sensitive-looking column, as discovered from the migrations */
  columns: Record<string, ColumnSink>;
}

export interface OtherSink {
  id: string;
  kind: "artifact" | "file" | "log" | "telemetry" | "workflow-history" | "model-visible" | "env";
  where: string;
  classification: DataClass;
  protection: Protection;
  retention: Retention;
  owner: string;
  assurance: Assurance;
  /** the leak-suite path (tests/security/persistence-leaks.test.ts) that exercises it, when one does */
  leakPath?: string;
  note?: string;
}

/* --------------------------------- helpers -------------------------------- */

const guarded = (guard: string, assurance: Assurance = "design", note?: string): ColumnSink => ({ protection: { kind: "write-guarded", guard }, assurance, ...(note ? { note } : {}) });
const sealedBox = (purpose: KeyPurpose, note?: string): ColumnSink => ({ protection: { kind: "sealed", scheme: "result-box", purpose }, classification: "secret", assurance: "tested", ...(note ? { note } : {}) });
const digestOnly = (note?: string): ColumnSink => ({ protection: { kind: "digest-only" }, assurance: "design", ...(note ? { note } : {}) });
const plain = (reason: string): ColumnSink => ({ protection: { kind: "none-needed", reason }, assurance: "design" });
const tenant = (note: string, assurance: Assurance = "design", classification: DataClass = "tenant-content"): ColumnSink => ({ protection: { kind: "tenant-content", note }, classification, assurance });
const unreviewed = (note: string, classification: DataClass = "tenant-content"): ColumnSink => ({ protection: { kind: "tenant-content", note }, classification, assurance: "unreviewed" });

const ledger = (note: string): Retention => ({ policy: "ledger", note });
const expiring = (note: string): Retention => ({ policy: "expiring", note });
const operational = (note: string): Retention => ({ policy: "operational", note });
const immutable = (note: string): Retention => ({ policy: "immutable", note });
const customer = (note: string): Retention => ({ policy: "customer-controlled", note });

const OPS07 = "No automatic deletion; retention policy is PROD-OPS-07.";
const GUARD_EVENTS = "events.append -> assertNoSecretValues(data)";

/* --------------------------------- tables --------------------------------- */

export const TABLES: Readonly<Record<string, TableSink>> = {
  /* ------------------------------ platform: ledger ------------------------------ */
  "platform.operations": { owner: "controlplane/operations", classification: "operational", retention: ledger(OPS07), purpose: "operation ledger: proposals, approvals binding, results",
    columns: { principal: plain("actor id, name and role; no credentials"), proposal: guarded("operations.create -> assertNoSecretValues(proposal)"), plan_digest: digestOnly(), result: guarded("operations.update -> assertNoSecretValues(result)"), error: guarded("operations.update -> assertNoSecretValues(error)") } },
  "platform.idempotency_keys": { owner: "controlplane/idempotency", classification: "secret", retention: expiring("pruned by housekeeping when expired (30 day machine artifacts)"), purpose: "replay protection; machine replay artifacts and exec output",
    columns: { response: { protection: { kind: "sealed", scheme: "result-box", purpose: "enc:machine-results" }, classification: "secret", assurance: "tested", note: "idempotency.complete has exactly one caller (machines/persistence), which seals; a source scan test pins that" } } },
  "platform.leases": { owner: "controlplane/leases", classification: "operational", retention: operational("expires with the lease"), purpose: "fenced leases", columns: {} },
  "platform.approvals": { owner: "controlplane/approvals", classification: "personal-data", retention: ledger(OPS07), purpose: "approval decisions bound to exact proposals", columns: { approver: plain("approver id, name and role") } },
  "platform.policy_decisions": { owner: "controlplane/policy", classification: "operational", retention: ledger(OPS07), purpose: "policy decision records",
    columns: { reasons: guarded("policyDecisions.insert -> assertNoSecretValues(reasons)"), approval: plain("approval requirement flags"), constraints: guarded("policyDecisions.insert -> assertNoSecretValues(constraints)") } },
  "platform.capability_grants": { owner: "capabilities/grants", classification: "operational", retention: ledger(OPS07), purpose: "issued grant ids (jti) only, never the signed grant", columns: {} },
  "platform.events": { owner: "controlplane/events", classification: "operational", retention: ledger(OPS07), purpose: "append-only event log",
    columns: { actor: plain("actor id and name"), data: guarded(GUARD_EVENTS, "tested", "tests/security/store-value-boundaries.test.ts pins what is refused and what is not") } },
  "platform.evidence": { owner: "controlplane/evidence", classification: "operational", retention: ledger(OPS07), purpose: "evidence records: digests and bounded summaries",
    columns: { summary: guarded("evidence.insert -> assertNoSecretValues(summary)", "tested") } },
  "platform.environment_settings": { owner: "controlplane/settings", classification: "operational", retention: operational("current settings"), purpose: "per-environment policy parameters",
    columns: { policy_params: guarded("settings.putEnvironmentSettings -> assertNoSecretValues(policyParams)") } },
  "platform.workspace_policy": { owner: "controlplane/settings", classification: "operational", retention: operational("current policy"), purpose: "workspace policy parameters",
    columns: { params: guarded("settings.putWorkspacePolicy -> assertNoSecretValues(params)") } },
  "platform.provider_connections": { owner: "controlplane/connections", classification: "credential-derived", retention: operational("until the connection is revoked; revoked rows are kept"), purpose: "provider connections: role references and non-secret config",
    columns: { config: guarded("connections.create -> assertNoSecretKeys(config); static credentials are never stored (ADR-0006)", "tested"), verification_detail: plain("fixed verification vocabulary") } },
  "platform.connection_rotations": { owner: "controlplane/connection-rotations", classification: "credential-derived", retention: ledger("promoted, aborted and superseded rows are the audit history"), purpose: "staged non-secret candidate connection config",
    columns: { base_config_digest: digestOnly(), candidate_config: guarded("connectionRotations.stage -> assertNoSecretKeys(candidateConfig)"), verification_detail: plain("fixed verification vocabulary") } },
  "platform.resources": { owner: "controlplane/resources", classification: "operational", retention: operational("current desired graph"), purpose: "desired resource graph",
    columns: { native_type: plain("provider type name"), spec: guarded("resources.upsertDesired -> assertNoSecretValues(spec)"), depends_on: plain("addresses"), origin: plain("provenance ids"), labels: plain("labels") } },
  "platform.resource_observations": { owner: "controlplane/observations", classification: "tenant-content", retention: expiring("bounded history pruned by observations.prune"), purpose: "observed provider state",
    columns: { attributes: guarded("observations.appendObservation -> assertNoSecretValues(attributes)", "tested", "tests/security/reconcile-value-boundaries.test.ts"), native: guarded("observations.appendObservation -> assertNoSecretValues(native)", "tested"), error: plain("redacted provider error text, bounded") } },
  "platform.resource_runtime": { owner: "controlplane/observations", classification: "operational", retention: operational("latest only"), purpose: "latest runtime health", columns: { counts: plain("numbers"), signals: plain("signal names and states") } },
  "platform.drift_reports": { owner: "controlplane/drift", classification: "operational", retention: expiring("pruned by drift.prune"), purpose: "drift findings",
    columns: { findings: unreviewed("scrubbed observed values; SEC-F13 notes expected attributes can appear", "operational"), unobserved: plain("addresses") } },
  "platform.cost_estimates": { owner: "cost", classification: "operational", retention: ledger(OPS07), purpose: "cost estimates", columns: { estimate: plain("prices and quantities") } },
  "platform.reconcile_state": { owner: "reconcile", classification: "operational", retention: operational("latest only"), purpose: "reconcile scheduling state", columns: { finding_since: plain("timestamps") } },
  "platform.scheduled_job_runs": { owner: "platform/critical-jobs", classification: "operational", retention: operational("one row per job"), purpose: "critical job health", columns: { last_error_code: plain("fixed code vocabulary"), last_counts: plain("numbers only") } },

  /* ------------------------------ platform: agents ------------------------------ */
  "platform.agent_update_controls": { owner: "runners/update-control", classification: "personal-data", retention: operational("current desired intent and human actor id; no automatic deletion"), purpose: "tenant-scoped human update and hold intent; no release credentials or artifact content",
    columns: { manifest_sha256: digestOnly("SHA-256 of exact signed release envelope bytes") } },
  "platform.runners": { owner: "runners", classification: "operational", retention: operational("until revoked"), purpose: "registered runners (public key only)",
    columns: { capabilities: plain("capability names"), labels: plain("labels"), host: plain("host facts"), lifecycle: plain("lifecycle state") } },
  "platform.runner_registration_tokens": { owner: "runners", classification: "credential-derived", retention: expiring("single use, expires"), purpose: "registration tokens, stored as a hash",
    columns: { token_hash: digestOnly("sha-256 of the token; the token is shown once"), binding: guarded("runners.createRegistrationToken -> assertNoSecretKeys(binding)") } },
  "platform.runner_jobs": { owner: "runners", classification: "secret", retention: { policy: "minimized", by: "data-minimize", note: "DEC-RETENTION-gated: dry run by default; the sealed result body is removed only with ZENITH_DATA_MINIMIZE_APPLY=1 and an explicit ZENITH_RESULT_RETENTION_HOURS; the job row, status and envelope stay" }, purpose: "signed job queue and result rendezvous",
    columns: { envelope: plain("signed job envelope: parameters, never credentials (credentials never reach the control plane)"), result: sealedBox("enc:results", "{sealed, exitCode, startedAt, finishedAt}; sealed by the result key ring"), error: guarded("jobs.settle -> assertNoSecretValues(error)") } },
  "platform.runner_job_logs": { owner: "runners", classification: "operational", retention: ledger(`Operator-visible job logs. ${OPS07}`), purpose: "runner job log lines (8 KiB cap)",
    columns: { line: guarded("jobs.appendLogs -> assertNoSecretValues(line); runner-side redaction", "design", "free text: an unrecognised secret printed by a job persists here; documented limit") } },
  "platform.agent_nonces": { owner: "runners", classification: "operational", retention: expiring("pruned by housekeeping"), purpose: "request replay nonces", columns: {} },
  "platform.machines": { owner: "machines", classification: "operational", retention: operational("until revoked"), purpose: "zenithd machine registrations",
    columns: { capabilities: plain("capability names"), labels: plain("labels"), host: plain("host facts"), lifecycle: plain("lifecycle state") } },
  "platform.machine_requests": { owner: "machines", classification: "secret", retention: { policy: "minimized", by: "data-minimize", note: "same as runner_jobs (dry run by default)" }, purpose: "signed zenithd request queue and result rendezvous",
    columns: { envelope: plain("signed request envelope: parameters, never credentials"), result: sealedBox("enc:results"), error: guarded("machine-requests.settle -> assertNoSecretValues(error)") } },
  "platform.machine_request_logs": { owner: "machines", classification: "operational", retention: ledger(`Operator-visible request logs. ${OPS07}`), purpose: "zenithd request log lines",
    columns: { line: guarded("machine-requests.appendLogs -> assertNoSecretValues(line)", "design", "free text; same limit as runner_job_logs") } },
  "platform.agent_effect_receipts": { owner: "runners/effect receipts", classification: "secret", retention: immutable("immutable by trigger: cannot be changed or removed; retention policy is PROD-OPS-07"), purpose: "permanent receipts of agent outcomes",
    columns: { envelope_digest: digestOnly(), sealed: sealedBox("enc:results", "the whole outcome body, sealed under the result key ring; this copy is immutable") } },

  /* ------------------------------- platform: plans ------------------------------ */
  "platform.isolation_plan_custody": { owner: "managed isolation custody (DUR-C)", classification: "raw-plan-or-state", retention: immutable("write-once; logically unavailable after operation expiry; retention purge requires a future reviewed migration"), purpose: "authenticated direct-object onboarding plans",
    columns: { plan_digest: digestOnly(),
      auth_tag: { protection: { kind: "sealed", scheme: "plan-columns", purpose: "enc:plan-artifacts" }, classification: "raw-plan-or-state", assurance: "design" },
      ciphertext: { protection: { kind: "sealed", scheme: "plan-columns", purpose: "enc:plan-artifacts" }, classification: "raw-plan-or-state", assurance: "design" } } },
  "platform.plan_artifacts": { owner: "plan custody (DUR-C)", classification: "raw-plan-or-state", retention: expiring("logical expiry by planArtifacts.expire"), purpose: "encrypted raw plan custody",
    columns: { manifest: unreviewed("plaintext manifest beside the ciphertext: addresses and digests; DUR-C owns it", "operational"), manifest_digest: digestOnly(), plan_digest: digestOnly(),
      auth_tag: { protection: { kind: "sealed", scheme: "plan-columns", purpose: "enc:plan-artifacts" }, classification: "raw-plan-or-state", assurance: "tested" },
      ciphertext: { protection: { kind: "sealed", scheme: "plan-columns", purpose: "enc:plan-artifacts" }, classification: "raw-plan-or-state", assurance: "tested", note: "tests/security/plan-artifact-secrecy.test.ts" } } },
  "platform.plan_artifact_associations": { owner: "plan custody (DUR-C)", classification: "operational", retention: ledger(OPS07), purpose: "plan to source associations", columns: { source_manifest_digest: digestOnly() } },
  "platform.plan_artifact_uses": { owner: "plan custody (DUR-C)", classification: "operational", retention: ledger(OPS07), purpose: "plan artifact use phases", columns: {} },
  "platform.standalone_plan_backends": { owner: "plan custody (DUR-C)", classification: "operational", retention: ledger(OPS07), purpose: "standalone plan backend digests", columns: {} },
  "platform.standalone_plan_settlements": { owner: "plan custody (DUR-C)", classification: "raw-plan-or-state", retention: ledger(OPS07), purpose: "sealed standalone settlements",
    columns: { manifest_digest: digestOnly(),
      auth_tag: { protection: { kind: "sealed", scheme: "plan-columns", purpose: "enc:plan-artifacts" }, classification: "raw-plan-or-state", assurance: "tested" },
      ciphertext: { protection: { kind: "sealed", scheme: "plan-columns", purpose: "enc:plan-artifacts" }, classification: "raw-plan-or-state", assurance: "tested" } } },
  "platform.build_launches": { owner: "execution/build", classification: "operational", retention: ledger(OPS07), purpose: "build launch claims",
    columns: { binding: plain("digests and ids"), plan_digest: digestOnly(), request_ids: plain("request ids") } },
  "platform.approved_source_snapshots": { owner: "execution/source", classification: "tenant-content", retention: ledger(OPS07), purpose: "approved source snapshot metadata",
    columns: { snapshot: unreviewed("file names, sizes and digests of the approved source; no file contents", "operational") } },
  "platform.workflow_start_intents": { owner: "workflows/start-intent", classification: "operational", retention: ledger(OPS07), purpose: "durable workflow start intents", columns: { binding: plain("digests and ids") } },
  "platform.mixed_child_custody": { owner: "execution/mixed-child", classification: "operational", retention: ledger(OPS07), purpose: "mixed child descriptors", columns: { descriptor: plain("ids and digests") } },
  "platform.mixed_child_intents": { owner: "execution/mixed-child", classification: "operational", retention: ledger(OPS07), purpose: "mixed child intents", columns: { receipt: plain("ids and digests") } },
  /* ---------------- platform: waves 3 and 4 (classified at the wave-4 assembly) ---------------- */
  "platform.operation_authority": { owner: "controlplane/authority (DUR-A)", classification: "operational", retention: operational("one row per operation; cascades with the operation"), purpose: "versioned fence record per operation",
    columns: { plan_digest: digestOnly() } },
  "platform.durable_intents": { owner: "controlplane/outbox (DUR-A)", classification: "operational", retention: ledger("settled intents are kept as the delivery record; " + OPS07), purpose: "outbox of effects that leave the database (workflow signals and starts)",
    columns: { payload: plain("bounded to 4000 bytes by a check; built by code from ids, digests and decision words, never from request text"), payload_digest: digestOnly(), last_error_code: plain("fixed error vocabulary, 64 characters at most") } },
  "platform.approved_semantics": { owner: "controlplane/executable-semantics (DUR-B)", classification: "operational", retention: immutable("write-once by trigger; " + OPS07), purpose: "executable-semantics digest the reviewer approved",
    columns: { plan_digest: digestOnly(), semantics: plain("component digests and short component names only, never a configuration value (migration header)") } },
  "platform.standing_grants": { owner: "controlplane/standing-grants (DUR-B)", classification: "personal-data", retention: ledger("grants are revoked, never deleted; " + OPS07), purpose: "bounded standing pre-approvals for repeat agent operations",
    columns: { capabilities: plain("capability names"), allowed_principals: plain("agent principal ids") } },
  "platform.standing_grant_uses": { owner: "controlplane/standing-grants (DUR-B)", classification: "operational", retention: ledger(OPS07), purpose: "one row per operation a standing grant approved", columns: {} },
  "platform.plan_custody_grants": { owner: "plan custody (DUR-C)", classification: "credential-derived", retention: ledger("grants are revoked, never deleted; " + OPS07), purpose: "worker-bound custody grants for encrypted plan artifacts",
    columns: { manifest_digest: digestOnly(), token_digest: digestOnly("digest of the worker custody token, not the token"),
      wrap_ciphertext: { protection: { kind: "sealed", scheme: "plan-columns", purpose: "enc:plan-artifacts" }, classification: "credential-derived", assurance: "tested", note: "the custody binding wrapped under the worker token; iv and tag sit beside it (wrap_iv, wrap_tag); tests/controlplane/plan-custody.test.ts" } } },
  "platform.plan_custody_reads": { owner: "plan custody (DUR-C)", classification: "operational", retention: immutable("append-only by trigger; " + OPS07), purpose: "audit of every plan custody read, allowed or refused",
    columns: { manifest_digest: digestOnly() } },
  "platform.state_backend_probes": { owner: "execution/state-backend (DUR-C)", classification: "operational", retention: immutable("append-only by trigger; " + OPS07), purpose: "state backend capability probe verdicts",
    columns: { verdict: plain("capability booleans and fixed reason words, bounded to 16 KiB by a check; no state content") } },
  "platform.state_backend_restores": { owner: "execution/state-backend (DUR-C)", classification: "operational", retention: ledger("restore records are never deleted; " + OPS07), purpose: "human-approved state restore proposals and outcomes",
    columns: { backend: plain("backend kind, bucket or container, key and version ids; never credentials (backend config carries references only), bounded to 4 KiB"), requested_by: plain("requester id, name and role") } },
  "platform.external_effects": { owner: "effects ledger (DUR-D)", classification: "operational", retention: ledger("permanent: rows are never deleted; " + OPS07), purpose: "permanent ledger of provider mutations dispatched or refused",
    columns: { target: plain("provider, region and resource identifiers, bounded to 8 KB"), idempotency_token: plain("client token that goes to the provider; a random identifier, not a credential"),
      provider_receipt: plain("provider request and resource ids, bounded to 8 KB; receipts are built from response ids only"), late_receipt: plain("provider request and resource ids of a receipt that arrived after a tombstone"),
      readback: plain("provider readback summaries (ids, counts, digests), bounded to 16 KB") } },
  "platform.external_effect_events": { owner: "effects ledger (DUR-D)", classification: "operational", retention: immutable("append-only by trigger; " + OPS07), purpose: "state change events of external effects", columns: {} },
  "platform.external_effect_resolutions": { owner: "effects ledger (DUR-D)", classification: "personal-data", retention: immutable("append-only by trigger; " + OPS07), purpose: "operator resolutions of uncertain or conflicting effects", columns: {} },
  "platform.mcp_streams": { owner: "agent-access/v3 stream (UX-02)", classification: "operational", retention: expiring("streams expire after 900 seconds; " + OPS07), purpose: "resumable MCP stream records", columns: {} },
  "platform.mcp_stream_events": { owner: "agent-access/v3 stream (UX-02)", classification: "tenant-content", retention: expiring("events are bounded to 256 per stream and expire with it; " + OPS07), purpose: "buffered MCP stream events for resume",
    columns: { payload: tenant("the JSON-RPC message the broker already returned to this principal (broker results are secret-scrubbed before they leave); replayed only to the same authenticated principal digest; a secret with no recognisable shape would be stored as given", "design") } },
  "platform.coding_agent_runs": { owner: "coding-agent (MACH-06)", classification: "tenant-content", retention: ledger("runs are kept as the audit of agent work; " + OPS07), purpose: "durable coding agent runs",
    columns: { source: plain("repository and ref identifiers and digests"), limits: plain("numeric budgets"), usage: plain("numeric counters"),
      checkpoint: tenant("model conversation and tool results needed to resume; tool results come from broker-mediated reads that are scrubbed, model text is not; a secret with no recognisable shape pasted into a task would be stored as given", "design"),
      result: tenant("final outcome summary and proposal ids; no credentials (proposals go through the broker)", "design") } },
  "platform.actual_spend_snapshots": { owner: "cost/billing (COST-01)", classification: "operational", retention: ledger("snapshots are kept as billing history; " + OPS07), purpose: "provider-reported actual spend snapshots",
    columns: { response_sha256: digestOnly("SHA-256 of the provider billing response; no raw response"), snapshot: plain("totals, service line names, currency and the SHA-256 of the provider response; billing credentials are read from files at call time and never stored") } },
  "platform.ops_maintenance": { owner: "ops/maintenance (OPS-02)", classification: "operational", retention: operational("single global row"), purpose: "maintenance mode state", columns: {} },
  "platform.ops_maintenance_history": { owner: "ops/maintenance (OPS-02)", classification: "personal-data", retention: immutable("append-only by trigger; " + OPS07), purpose: "maintenance mode change history", columns: {} },
  "platform.tenant_quotas": { owner: "ops/quotas (OPS-02)", classification: "operational", retention: operational("current per-workspace quota overrides"), purpose: "per-tenant dispatch quotas", columns: {} },
  "platform.mixed_parent_plans": { owner: "execution/mixed (MIX-01)", classification: "operational", retention: ledger(OPS07), purpose: "mixed parent plans: ordered children, dependencies and output contracts",
    columns: { plan_id: plain("plan id"), manifest_digest: digestOnly(), plan: plain("child references, partition digests, ordering and output contract names; output values are never part of a plan") } },
  "platform.mixed_child_plans": { owner: "execution/mixed (MIX-01)", classification: "operational", retention: ledger(OPS07), purpose: "per-child subplans of a mixed parent plan",
    columns: { plan_id: plain("plan id"), subplan_digest: digestOnly(), subplan: plain("the child partition (provider resources by address and non-secret spec, the same desired graph the single-provider path stores)") } },
  "platform.mixed_child_receipts": { owner: "execution/mixed (MIX-01)", classification: "operational", retention: ledger(OPS07), purpose: "child completion receipts",
    columns: { plan_id: plain("plan id"), plan_digest: digestOnly(), outputs_digest: digestOnly("digest of materialized outputs, never the outputs") } },
  "platform.mixed_addresses": { owner: "execution/mixed (MIX-01)", classification: "operational", retention: ledger(OPS07), purpose: "stable address registry across mixed plan versions", columns: { plan_id: plain("plan id") } },
  "platform.mixed_runs": { owner: "execution/mixed-orchestration (MIX-03)", classification: "operational", retention: ledger(OPS07), purpose: "mixed run state: per-child status, ordering and teardown",
    columns: { state: plain("child states, digests and output provenance; secret-typed outputs carry vault references only, bounded to 1 MiB by a check") } },
  "platform.mixed_run_events": { owner: "execution/mixed-orchestration (MIX-03)", classification: "operational", retention: immutable("append-only run events; " + OPS07), purpose: "mixed run event log",
    columns: { event: plain("transition words, child ids and digests, bounded to 64 KiB by a check") } },
  "platform.mixed_output_preauthorizations": { owner: "execution/mixed-orchestration (MIX-04)", classification: "credential-derived", retention: ledger("revoked or exhausted rows are kept; " + OPS07), purpose: "human pre-authorizations of cross-provider output values",
    columns: { consumer_subplan_digest: digestOnly(), producer_subplan_digest: digestOnly(), secret_ref: plain("vault reference id (vault:workspace/scope/name), never the secret value; the value stays in the tenant vault") } },
  "platform.cleanup_writer_epoch": { owner: "execution/cleanup", classification: "operational", retention: operational("single epoch"), purpose: "cleanup writer epoch", columns: {} },
  "platform.cleanup_writer_scopes": { owner: "execution/cleanup", classification: "operational", retention: operational("per scope"), purpose: "cleanup writer scopes", columns: {} },
  "platform.cleanup_writer_holds": { owner: "execution/cleanup", classification: "operational", retention: ledger(OPS07), purpose: "cleanup writer holds", columns: { manifest_digest: digestOnly() } },
  "platform.cleanup_writer_deliveries": { owner: "execution/cleanup", classification: "operational", retention: ledger(OPS07), purpose: "cleanup writer deliveries", columns: {} },
  "platform.cleanup_owner_grants": { owner: "execution/cleanup", classification: "operational", retention: ledger(OPS07), purpose: "cleanup owner grant ids (jti)", columns: {} },
  "platform.cleanup_writer_hold_releases": { owner: "execution/cleanup", classification: "operational", retention: ledger(OPS07), purpose: "append-only release of a superseded cleanup hold generation (schema 60, not yet written)",
    columns: { inventory_snapshot: plain("per-family possible-delivery counts at release; numbers only, no identifiers") } },
  "platform.cleanup_writer_settlements": { owner: "execution/cleanup", classification: "operational", retention: ledger(OPS07), purpose: "append-only settlement of one earlier possible delivery (schema 60, not yet written)",
    columns: { sealed: unreviewed("reserved for the authenticated settlement envelope; no writer in schema 60") } },
  "platform.cleanup_direct_attempts": { owner: "execution/cleanup", classification: "operational", retention: ledger(OPS07), purpose: "direct-path cleanup attempt bound to reviewed provider-teardown evidence (schema 60, not yet written)", columns: {} },

  /* ---------------------------- platform: product lifecycle ---------------------------- */
  "platform.github_source_bindings": { owner: "sources/github", classification: "operational", retention: ledger(OPS07), purpose: "repository bindings (no tokens)", columns: {} },
  "platform.github_install_intents": { owner: "sources/github", classification: "operational", retention: expiring("deleted when consumed or expired"), purpose: "install intents (digests only)", columns: {} },
  "platform.github_binding_events": { owner: "sources/github", classification: "operational", retention: ledger(OPS07), purpose: "binding audit events", columns: {} },
  "platform.github_webhook_installation_epochs": { owner: "sources/github", classification: "operational", retention: operational("per app"), purpose: "webhook installation epochs", columns: {} },
  "platform.github_webhook_deliveries": { owner: "sources/github", classification: "operational", retention: ledger(OPS07), purpose: "webhook delivery ids; payloads are not stored", columns: { body_sha256: digestOnly("SHA-256 of the signed webhook body; no body content") } },
  "platform.machine_runbook_versions": { owner: "machines/runbooks", classification: "operational", retention: ledger(OPS07), purpose: "signed runbook definitions",
    columns: { definition: unreviewed("runbook steps and parameters; signed; no credentials by contract", "operational") } },
  "platform.machine_runbook_approvals": { owner: "machines/runbooks", classification: "operational", retention: ledger(OPS07), purpose: "runbook approvals", columns: {} },
  "platform.machine_runbook_schedules": { owner: "machines/runbooks", classification: "operational", retention: operational("until cancelled"), purpose: "runbook schedules",
    columns: { spec: plain("schedule spec"), targets: plain("target addresses"), creator: plain("actor id and name") } },
  "platform.machine_runbook_runs": { owner: "machines/runbooks", classification: "operational", retention: ledger(OPS07), purpose: "runbook runs", columns: { targets: plain("target addresses"), requester: plain("actor id and name") } },
  "platform.machine_runbook_run_steps": { owner: "machines/runbooks", classification: "operational", retention: ledger(OPS07), purpose: "runbook run steps", columns: { error_code: plain("fixed code vocabulary") } },
  "platform.machine_runbook_audit": { owner: "machines/runbooks", classification: "operational", retention: ledger("hash-chained audit"), purpose: "tamper-evident runbook audit", columns: { detail: plain("fixed event details; no outputs") } },
  "platform.ownership_transfers": { owner: "ownership", classification: "operational", retention: ledger(OPS07), purpose: "field ownership transfers", columns: {} },
  "platform.incidents": { owner: "incidents", classification: "operational", retention: ledger(OPS07), purpose: "incident documents",
    columns: { document: guarded("incidents.openIncident -> assertNoSecretValues(document)"), escalation_reasons: plain("fixed reason codes") } },
  "platform.investigations": { owner: "incidents", classification: "operational", retention: ledger(OPS07), purpose: "incident investigations", columns: { document: guarded("incidents.insertInvestigation -> assertNoSecretValues(investigation)") } },
  "platform.incident_signal_state": { owner: "incidents", classification: "operational", retention: operational("latest only"), purpose: "signal debounce state", columns: {} },
  "platform.incident_remediation_attempts": { owner: "incidents", classification: "operational", retention: ledger(OPS07), purpose: "remediation attempts", columns: { block_codes: plain("fixed codes") } },
  "platform.incident_maintenance_windows": { owner: "incidents", classification: "operational", retention: ledger(OPS07), purpose: "maintenance windows", columns: {} },
  "platform.incident_postmortems": { owner: "incidents", classification: "operational", retention: ledger(OPS07), purpose: "postmortem documents", columns: { document: guarded("incidentStability.recordPostmortem -> assertNoSecretValues(doc)") } },
  "platform.optimizer_settings": { owner: "cost/optimizer", classification: "operational", retention: operational("current settings"), purpose: "optimizer opt-in", columns: {} },
  "platform.workspace_mfa_controls": { owner: "auth/workspace MFA (UX-01)", classification: "operational", retention: operational("current workspace settings; change history is in platform.events"), purpose: "workspace-owned MFA enforcement controls; no Auth factors, setup keys or codes", columns: {} },
  "platform.release_runs": { owner: "release", classification: "operational", retention: ledger(OPS07), purpose: "release pipeline runs",
    columns: { provenance: plain("digests and ids"), migration: plain("migration class and digests"), rollout: plain("rollout state"), readback: plain("probe results, bounded") } },
  "platform.release_events": { owner: "release", classification: "operational", retention: ledger(OPS07), purpose: "release state transitions", columns: { detail: plain("fixed transition detail") } },
  "platform.release_migration_approvals": { owner: "release", classification: "operational", retention: ledger(OPS07), purpose: "migration approvals", columns: {} },
  "platform.portability_exports": { owner: "portability", classification: "tenant-content", retention: ledger(OPS07), purpose: "export records (digests and destination labels; the data itself goes to the destination)",
    columns: { manifest_digest: digestOnly(), coverage: plain("coverage flags") } },
  "platform.portability_restores": { owner: "portability", classification: "operational", retention: ledger(OPS07), purpose: "restore records", columns: { readback: plain("digests and counts"), restored: plain("digests and counts") } },
  "platform.resource_adoptions": { owner: "ownership/adoption", classification: "operational", retention: ledger(OPS07), purpose: "adopted resource claims",
    columns: { native_type: plain("provider type name"), claim: plain("ids and addresses"), field_owners: plain("field ownership map"), baseline: guarded("adoption baseline from guarded observations", "design"), baseline_digest: digestOnly() } },
  "platform.plugin_registrations": { owner: "plugins", classification: "operational", retention: ledger(OPS07), purpose: "plugin registrations (manifests, provenance)",
    columns: { manifest_digest: digestOnly(), manifest: plain("signed manifest; env must not carry credentials (manifest schema refuses secret-named keys)"), provenance: plain("publisher id, key id, digests"), approved_tools: plain("tool names"), approved_scopes: plain("scope names") } },
  "platform.plugin_grants": { owner: "plugins", classification: "credential-derived", retention: expiring("revocable, expiring grants"), purpose: "plugin grants; the token is shown once and stored as a hash",
    columns: { token_hash: digestOnly("sha-256 of the token"), credential_id: plain("credential id"), scopes: plain("scope names"), project_ids: plain("ids"), environment_ids: plain("ids") } },
  "platform.plugin_events": { owner: "plugins", classification: "operational", retention: ledger(OPS07), purpose: "plugin audit events", columns: { detail: plain("fixed event details") } },
  "platform.schema_migrations": { owner: "controlplane/migrator", classification: "operational", retention: ledger("migration ledger"), purpose: "applied migration checksums", columns: {} },
  "platform.key_custody_keys": { owner: "keycustody", classification: "operational", retention: ledger("non-secret key facts; retired rows are kept as history"), purpose: "key ids, roles, ages, retirement dates (never material)", columns: {} },
  "platform.key_rewrap_jobs": { owner: "keycustody", classification: "operational", retention: ledger("job history"), purpose: "durable vault re-wrap jobs (cursor and counts)", columns: { error_code: plain("fixed code vocabulary") } },


  /* Wave 5 assembly: mechanisms remain unverified against native services. */
  "platform.mixed_output_records": { owner: "mixed execution", classification: "tenant-content", retention: ledger("immutable output provenance"), purpose: "producer outputs for approved consumers", columns: { plan_id: plain("plan identifier"), producer_output: plain("output name"), secret_ref: plain("vault reference only"), secret_version_digest: digestOnly("secret version binding"), value: tenant("bounded non-secret scalar; secret outputs carry only vault references") } },
  "platform.slo_samples": { owner: "ops/slo", classification: "operational", retention: operational("35 days, pruned by flushSloSamples"), purpose: "aggregate SLI counts", columns: {} },
  "platform.slo_measurements": { owner: "ops/slo", classification: "operational", retention: ledger("append-only measurement evidence"), purpose: "provisional recovery/capacity measurements", columns: { details: plain("fixed numeric, ISO time and short reference fields") } },
  "platform.recovery_epochs": { owner: "ops/recovery", classification: "personal-data", retention: ledger("permanent recovery timeline"), purpose: "installation recovery epoch and operator provenance", columns: { manifest_digest: digestOnly("backup manifest digest") } },
  "platform.recovery_items": { owner: "ops/recovery", classification: "personal-data", retention: ledger("permanent recovery decisions"), purpose: "tenant recovery continuation and human decisions", columns: {} },
  "platform.legal_holds": { owner: "retention", classification: "personal-data", retention: ledger("legal hold history"), purpose: "operator holds and actor reasons", columns: {} },
  "platform.retention_archives": { owner: "retention", classification: "operational", retention: ledger("archive verification and prune facts"), purpose: "sealed archive destinations and digests", columns: {} },
  "platform.retention_destinations": { owner: "retention", classification: "operational", retention: ledger("tenant destination history"), purpose: "tenant-owned archive storage references", columns: { credentials_ref: plain("vault reference; no credential material") } },
  "platform.retention_restores": { owner: "retention", classification: "personal-data", retention: ledger("append-only restore audit"), purpose: "operator archive restore attempts", columns: { key_purpose: plain("explicit original key purpose"), restore_key_id: plain("key fingerprint only"), legacy_reason: guarded("operator plain audit reason"), detail: { ...guarded("retention.restore audit -> assertNoSecretValues(detail)"), assurance: "design" } } },
  "platform.audit_exports": { owner: "audit-export", classification: "personal-data", retention: ledger("append-only chain facts"), purpose: "signed export chain and operator provenance", columns: {} },
  "platform.managed_domains": { owner: "managed-serving", classification: "operational", retention: customer("domain and revoke lifecycle"), purpose: "tenant domain verification", columns: {} },
  "platform.managed_storage_keys": { owner: "managed-serving", classification: "credential-derived", retention: ledger("revocation history"), purpose: "object-store principals and revocation state", columns: { secret_ref: plain("vault reference only") } },
  "platform.billing_accounts": { owner: "billing", classification: "personal-data", retention: ledger("account and suspension history"), purpose: "provisional billing accounts", columns: { plan_id: plain("provisional plan identifier") } },
  "platform.billing_account_events": { owner: "billing", classification: "personal-data", retention: ledger("append-only account events"), purpose: "billing assignment/standing audit", columns: { detail: { ...guarded("billing.recordAccountEvent -> assertNoSecretValues(detail)"), assurance: "design" } } },
  "platform.billing_invoices": { owner: "billing", classification: "personal-data", retention: ledger("invoice lifecycle"), purpose: "provisional invoices", columns: { plan_id: plain("provisional plan identifier"), lines: plain("meter counts and provisional amounts"), last_error: { ...guarded("billing.recordInvoiceError -> assertNoSecretValues(message)"), assurance: "design" } } },
  "platform.billing_usage_events": { owner: "billing", classification: "operational", retention: ledger("idempotent usage records"), purpose: "meter usage facts", columns: { detail: plain("source identifiers and numeric usage") } },
  "platform.billing_webhook_events": { owner: "billing", classification: "operational", retention: ledger("payment webhook replay fence"), purpose: "payment-provider event identity and digest", columns: { payload_sha256: digestOnly("SHA-256 of the verified payment webhook payload; no payload content") } },

  /* ---------------------------------- public.* ---------------------------------- */
  "public.workspaces": { owner: "legacy product store", classification: "personal-data", retention: customer("workspace lifetime"), purpose: "workspaces", columns: { data: unreviewed("workspace name, owner id", "personal-data") } },
  "public.members": { owner: "legacy product store", classification: "personal-data", retention: customer("membership lifetime"), purpose: "members (emails)", columns: { data: unreviewed("name, email, role", "personal-data") } },
  "public.invites": { owner: "legacy product store", classification: "personal-data", retention: customer("until accepted or revoked"), purpose: "workspace invites", columns: { data: unreviewed("email, role, invite metadata", "personal-data") } },
  "public.connections": { owner: "legacy product store", classification: "credential-derived", retention: customer("until deleted"), purpose: "legacy provider connections: references, never static credentials", columns: { data: unreviewed("provider, account references, vault refs", "credential-derived") } },
  "public.projects": { owner: "legacy product store", classification: "tenant-content", retention: customer("project lifetime"), purpose: "projects", columns: { data: unreviewed("project manifest and settings; secret env values are vault references") } },
  "public.environments": { owner: "legacy product store", classification: "tenant-content", retention: customer("project lifetime"), purpose: "environments", columns: { data: unreviewed("environment settings") } },
  "public.revisions": { owner: "legacy product store", classification: "tenant-content", retention: customer("kept as history"), purpose: "revisions", columns: { data: unreviewed("revision metadata") } },
  "public.revision_manifests": { owner: "legacy product store", classification: "tenant-content", retention: customer("kept as history"), purpose: "revision manifests", columns: { manifest: unreviewed("literal env values under neutral names are stored as data; secrets are vault references (tests/security/audit-secret-leakage.test.ts)") } },
  "public.deployments": { owner: "legacy product store", classification: "tenant-content", retention: customer("kept as history"), purpose: "deployments", columns: { data: unreviewed("steps, outputs; step detail can echo provider text (SEC-R3 known)") } },
  "public.findings": { owner: "legacy product store", classification: "tenant-content", retention: customer("kept as history"), purpose: "security findings", columns: { data: unreviewed("finding text; tokens quoted in detail can survive (KNOWN_LEAKS in mcp-secret-leakage)") } },
  "public.navigator_runs": { owner: "legacy product store", classification: "tenant-content", retention: customer("kept as history"), purpose: "navigator runs", columns: { data: unreviewed("model prompts and plans, no credentials by design") } },
  "public.alert_rules": { owner: "legacy product store", classification: "tenant-content", retention: customer("until deleted"), purpose: "alert rules", columns: { data: unreviewed("rule definitions; channel secrets are vault references") } },
  "public.alert_events": { owner: "legacy product store", classification: "tenant-content", retention: customer("kept as history"), purpose: "alert events", columns: { data: unreviewed("alert text") } },
  "public.alert_outbox": { owner: "legacy product store", classification: "tenant-content", retention: expiring("outbox rows settle"), purpose: "alert delivery outbox", columns: { data: unreviewed("alert payload; webhook secrets are vault references") } },
  "public.settings": { owner: "legacy product store", classification: "operational", retention: customer("workspace lifetime"), purpose: "workspace settings", columns: { data: unreviewed("settings", "operational") } },
  "public.deployment_events": { owner: "legacy product store", classification: "tenant-content", retention: customer("kept as history"), purpose: "deployment log events", columns: { body: unreviewed("deployment log lines; a bearer token in a log line is a known leak (mcp-secret-leakage logToken)") } },
  "public.audit_events": { owner: "legacy product store", classification: "operational", retention: ledger(OPS07), purpose: "audit log",
    columns: { result: plain("ok or error"), data: { protection: { kind: "write-guarded", guard: "actions/core.ts redact by key name; compose import text omitted; capSnapshot budget" }, assurance: "tested", note: "tests/security/audit-secret-leakage.test.ts; free text under a neutral key name can persist" } } },
  "public.secrets": { owner: "secrets", classification: "secret", retention: customer("until the secret is removed"), purpose: "vault: sealed secret values",
    columns: { auth_tag: { protection: { kind: "sealed", scheme: "vault-columns", purpose: "enc:vault" }, classification: "secret", assurance: "tested" }, ciphertext: { protection: { kind: "sealed", scheme: "vault-columns", purpose: "enc:vault" }, classification: "secret", assurance: "tested", note: "the file store holds the same sealed parts in secrets.json at mode 0600" }, meta: plain("created/updated by and at; never the value") } },
  "public.workspace_versions": { owner: "legacy product store", classification: "operational", retention: operational("version counter"), purpose: "workspace version counters", columns: { touched_projects: plain("project ids") } },
  "public.waitlist_entries": { owner: "waitlist", classification: "personal-data", retention: customer("until admitted and removed"), purpose: "waitlist signups (email, occupation, use case)", columns: {} },
  "public.waitlist_admission_batches": { owner: "waitlist", classification: "personal-data", retention: ledger(OPS07), purpose: "admission batches", columns: { entries: unreviewed("admitted email list", "personal-data") } },
  "public.waitlist_rate_limits": { owner: "waitlist", classification: "operational", retention: expiring("window expiry"), purpose: "intake rate limits keyed by an HMAC (never the raw address)", columns: {} },
  "public.waitlist_admission_previews": { owner: "waitlist", classification: "operational", retention: expiring("preview expiry"), purpose: "admission previews", columns: {} },

  /* ---------------------------------- hosted.* ---------------------------------- */
  "hosted.schema_migrations": { owner: "hosted", classification: "operational", retention: ledger("migration ledger"), purpose: "hosted migration ledger", columns: {} },
  "hosted.apps": { owner: "hosted", classification: "operational", retention: customer("app lifetime"), purpose: "hosted apps", columns: {} },
  "hosted.app_grants": { owner: "hosted", classification: "personal-data", retention: customer("grant lifetime"), purpose: "app access grants (email)", columns: {} },
  "hosted.app_invites": { owner: "hosted", classification: "credential-derived", retention: expiring("expires; accepted rows kept"), purpose: "app invites; the token is stored as a hash", columns: { token_hash: digestOnly("hash of the invite token") } },
  "hosted.invite_deliveries": { owner: "hosted", classification: "secret", retention: { policy: "settle-erase", note: "sealed_payload is erased by clearSealedPayload once the row settles" }, purpose: "invite email delivery state",
    columns: { error: plain("delivery error text, bounded"), sealed_payload: { protection: { kind: "sealed", scheme: "opaque-bytes", purpose: "enc:vault" }, classification: "secret", assurance: "design", note: "AES-GCM sealed invite token under ZENITH_SECRET_KEY directly (hosted/access/seal.ts): no decrypt-only overlap, so a vault key rotation fails outstanding deliveries closed; erased when the row settles" } } },
  "hosted.app_sessions": { owner: "hosted", classification: "operational", retention: expiring("session expiry"), purpose: "app sessions (ids only)", columns: {} },
  "hosted.app_exchanges": { owner: "hosted", classification: "credential-derived", retention: expiring("exchange expiry"), purpose: "one-time exchange codes, stored as a hash", columns: {} },
  "hosted.hosted_jobs": { owner: "hosted", classification: "operational", retention: ledger(OPS07), purpose: "hosted publish jobs", columns: { result: unreviewed("job result text", "operational"), error: plain("bounded error text") } },
  "hosted.hosted_outbox": { owner: "hosted", classification: "operational", retention: expiring("outbox rows settle"), purpose: "hosted outbox", columns: { payload: unreviewed("outbox payload; invitation links are never stored (sealed in invite_deliveries)", "operational"), error: plain("bounded error text") } },
  "hosted.artifacts": { owner: "hosted", classification: "tenant-content", retention: customer("release lifetime"), purpose: "content-addressed artifact metadata", columns: {} },
  "hosted.releases": { owner: "hosted", classification: "operational", retention: ledger(OPS07), purpose: "hosted releases", columns: { error: plain("bounded error text") } },
  "hosted.quota_counters": { owner: "hosted", classification: "operational", retention: operational("per day"), purpose: "quota counters", columns: {} },
  "hosted.usage_ledger": { owner: "hosted", classification: "operational", retention: ledger(OPS07), purpose: "usage ledger", columns: {} },
  "hosted.revocation_ledger": { owner: "hosted", classification: "operational", retention: ledger("append-only"), purpose: "revocation ledger", columns: {} },
  "hosted.backup_manifests": { owner: "hosted", classification: "operational", retention: ledger(OPS07), purpose: "backup manifests (digests, key id)", columns: {} },
  "hosted.hosted_events": { owner: "hosted", classification: "operational", retention: ledger(OPS07), purpose: "hosted event log (subject hashed)", columns: {} },
  "hosted.app_records": { owner: "hosted", classification: "tenant-content", retention: customer("app lifetime"), purpose: "hosted app data records", columns: { body: tenant("end-user application data; protected by app grants and tenancy, not encrypted by Zenith") } },
  "hosted.app_writes": { owner: "hosted", classification: "tenant-content", retention: ledger("idempotent write results"), purpose: "idempotent app writes", columns: { result: tenant("echo of the app record write result") } },
  "hosted.app_storage": { owner: "hosted", classification: "operational", retention: operational("byte counters"), purpose: "storage byte counters", columns: {} },

  /* ----------------------------------- agent.* ---------------------------------- */
  "agent.schema_migrations": { owner: "agent access", classification: "operational", retention: ledger("migration ledger"), purpose: "agent migration ledger", columns: {} },
  "agent.agent_credentials": { owner: "agent access", classification: "credential-derived", retention: expiring("credential expiry; revoked rows kept"), purpose: "agent credentials; the token is stored as a hash",
    columns: { token_hash: digestOnly("sha-256 of the token"), project_ids: plain("ids"), environment_ids: plain("ids"), app_ids: plain("ids"), scopes: plain("scope names") } },
  "agent.agent_link_codes": { owner: "agent access", classification: "secret", retention: expiring("link code expiry"), purpose: "device link flow; the issued secret is sealed",
    columns: { requested_scopes: plain("scope names"), credential_id: plain("credential id"), secret_ct: { protection: { kind: "sealed", scheme: "opaque-bytes", purpose: "enc:vault" }, classification: "secret", assurance: "design", note: "sealed with the generic seal() under ZENITH_SECRET_KEY: no decrypt-only overlap and not covered by the vault re-wrap; short-lived link codes" } } },
  "agent.agent_rate_limits": { owner: "agent access", classification: "operational", retention: expiring("bucket expiry"), purpose: "agent rate limits", columns: {} },
  "agent.agent_operations": { owner: "agent access", classification: "operational", retention: ledger(OPS07), purpose: "agent control operations", columns: { document: unreviewed("operation request document: ids and digests", "operational") } },
  "agent.agent_operation_events": { owner: "agent access", classification: "operational", retention: ledger(OPS07), purpose: "agent operation events", columns: { document: unreviewed("event details", "operational") } },
  "agent.agent_uploads": { owner: "agent access", classification: "tenant-content", retention: { policy: "minimized", by: "data-minimize", note: "expired uploads are now swept on every maintenance tick, not only when another upload arrives" }, purpose: "uploaded source archives awaiting publish (one hour)",
    columns: { bytes: { protection: { kind: "tenant-content", note: "customer source archive, plaintext for at most one hour; may contain secrets the customer committed" }, classification: "tenant-content", assurance: "design" } } },
  "agent.agent_oauth_grants": { owner: "agent access", classification: "operational", retention: expiring("grant expiry"), purpose: "OAuth integration grants (ids and scopes)", columns: { project_ids: plain("ids"), environment_ids: plain("ids"), app_ids: plain("ids"), scopes: plain("scope names") } },
};

/* ------------------------------ non-table sinks ------------------------------ */

export const OTHER_SINKS: readonly OtherSink[] = [
  { id: "file.vault", kind: "file", where: "<ZENITH_DATA>/secrets.json (mode 0600)", classification: "secret", protection: { kind: "sealed", scheme: "vault-columns", purpose: "enc:vault" }, retention: customer("until the secret is removed"), owner: "secrets", assurance: "tested", leakPath: "vault" },
  { id: "file.product-snapshot", kind: "file", where: "<ZENITH_DATA> product JSON snapshot, event and audit logs", classification: "tenant-content", protection: { kind: "tenant-content", note: "same content classes as the public.* tables; secret values are vault references" }, retention: customer("until reset"), owner: "legacy product store", assurance: "unreviewed" },
  { id: "artifact.plan-files", kind: "artifact", where: "<ZENITH_WORKER_PLAN_DIR>/attempt-*/ binary plan files", classification: "raw-plan-or-state", protection: { kind: "host-protected", control: "directory mode 0700 on the worker's private volume; removed by the plan janitor after expiry; encrypt the volume" }, retention: expiring("plan janitor sweep, minimum age one hour"), owner: "plan custody (DUR-C) / execution", assurance: "design", note: "raw plan bytes are plaintext on the worker disk while an attempt is live; encrypted custody is in platform.plan_artifacts" },
  { id: "artifact.tofu-workspace", kind: "artifact", where: "OpenTofu working directories and state during an attempt", classification: "raw-plan-or-state", protection: { kind: "host-protected", control: "attempt-scoped directory mode 0700; state is remote (backend) or sealed in custody; removed when the attempt ends" }, retention: expiring("attempt scoped"), owner: "tofu runner", assurance: "tested", note: "tests/security/tofu-secrets.test.ts (real OpenTofu, gated)" },
  { id: "artifact.hosted-backup", kind: "artifact", where: "hosted backup objects", classification: "tenant-content", protection: { kind: "sealed", scheme: "backup-container", purpose: "enc:backup" }, retention: customer("backup policy"), owner: "hosted/backup", assurance: "design" },
  { id: "artifact.hosted-artifacts", kind: "artifact", where: "hosted artifact store (content-addressed)", classification: "tenant-content", protection: { kind: "tenant-content", note: "published customer app files; public by purpose once released" }, retention: customer("release lifetime"), owner: "hosted/artifacts", assurance: "design" },
  { id: "log.structured", kind: "log", where: "stdout/stderr JSON lines (src/lib/log.ts)", classification: "operational", protection: { kind: "write-guarded", guard: "log.ts passes every field through the shared credential redactor" }, retention: operational("owned by the operator's log pipeline"), owner: "log", assurance: "tested", leakPath: "logs", note: "best effort: an unrecognised secret in a log field is written as given" },
  { id: "log.runner-job-lines", kind: "log", where: "platform.runner_job_logs and machine_request_logs", classification: "operational", protection: { kind: "write-guarded", guard: "assertNoSecretValues on every line" }, retention: ledger(OPS07), owner: "runners", assurance: "tested", leakPath: "job-logs" },
  { id: "telemetry.envelope", kind: "telemetry", where: "telemetry envelopes and observability results (in memory, returned to callers)", classification: "tenant-content", protection: { kind: "write-guarded", guard: "observability/redact.ts redacts provider text; envelope carries only a session fingerprint, never credentials" }, retention: operational("not persisted by the control plane"), owner: "observability", assurance: "tested", leakPath: "telemetry" },
  { id: "evidence.records", kind: "artifact", where: "platform.evidence summaries and blob references", classification: "operational", protection: { kind: "write-guarded", guard: "evidence.insert -> assertNoSecretValues(summary); blobs live sealed in idempotency_keys" }, retention: ledger(OPS07), owner: "controlplane/evidence", assurance: "tested", leakPath: "evidence" },
  { id: "workflow.history", kind: "workflow-history", where: "Temporal workflow and activity payloads", classification: "operational", protection: { kind: "sealed", scheme: "temporal-envelope", purpose: "enc:temporal-payload" }, retention: operational("Temporal namespace retention"), owner: "workflows/codec", assurance: "tested", leakPath: "temporal", note: "workflow ids, visibility fields and default failure messages are NOT encrypted by the codec" },
  { id: "model.visible-results", kind: "model-visible", where: "MCP tool results and errors returned to a model", classification: "tenant-content", protection: { kind: "write-guarded", guard: "security/result-sanitizer.ts sanitizeForModel (always reports completeness best_effort)" }, retention: operational("not persisted"), owner: "security", assurance: "tested", leakPath: "model-visible" },
  { id: "env.installer-files", kind: "env", where: "installer-generated environment files and secret files", classification: "secret", protection: { kind: "host-protected", control: "written at mode 0600 by the installer; keys never printed" }, retention: operational("operator managed"), owner: "installer", assurance: "design", note: "owned by the installer; outside this workstream" },
];

/* --------------------------------- discovery -------------------------------- */

/**
 * A column needs an explicit inventory entry when it is `jsonb` or `bytea`, or a text column whose name suggests
 * stored content. Used by the completeness test against the migration SQL.
 */
// Legacy restore key metadata and its operator reason require explicit classification too.
export const SENSITIVE_TEXT_COLUMN = /(secret|token|password|credential|ciphertext|auth_tag|envelope|result|response|payload|body|output|plan|manifest|config|native|sealed|bytes|line|error|detail|^key_purpose$|^restore_key_id$|^legacy_reason$)/;

export interface DiscoveredTable { table: string; columns: string[] }

const TYPE = /^\s{1,4}([a-z_][a-z_0-9]*)\s+(jsonb|bytea|text|bigint|integer|boolean|timestamptz|double|text\[\]|inet)\b/;
const NOT_COLUMN = new Set(["primary", "unique", "check", "foreign", "constraint"]);

/** Tables and their sensitive-looking columns, from `create table` / `alter table add column` statements. */
export function discoverSensitiveColumns(sql: string, schemas: readonly string[]): DiscoveredTable[] {
  const out = new Map<string, Set<string>>();
  const wanted = (table: string): boolean => schemas.some((s) => table.startsWith(`${s}.`));
  const create = /create table (?:if not exists )?([a-z]+\.[a-z_]+)\s*\(([\s\S]*?)\n\);/g;
  for (let m = create.exec(sql); m; m = create.exec(sql)) {
    if (!wanted(m[1])) continue;
    const cols = out.get(m[1]) ?? new Set<string>();
    for (const line of m[2].split("\n")) {
      const c = TYPE.exec(line);
      if (!c || NOT_COLUMN.has(c[1])) continue;
      if (c[2] === "jsonb" || c[2] === "bytea" || (c[2] === "text" && SENSITIVE_TEXT_COLUMN.test(c[1]))) cols.add(c[1]);
    }
    out.set(m[1], cols);
  }
  const alter = /alter table (?:if exists )?([a-z]+\.[a-z_]+)\s+add column (?:if not exists )?([a-z_]+)\s+(jsonb|text|bytea)/g;
  for (let m = alter.exec(sql); m; m = alter.exec(sql)) {
    if (!wanted(m[1])) continue;
    if (m[3] !== "text" || SENSITIVE_TEXT_COLUMN.test(m[2])) (out.get(m[1]) ?? out.set(m[1], new Set()).get(m[1])!).add(m[2]);
  }
  return [...out].map(([table, columns]) => ({ table, columns: [...columns].sort() }));
}

export interface InventoryGap {
  kind: "table_missing" | "column_missing" | "table_stale" | "column_stale";
  table: string;
  column?: string;
}

/** Compare discovered schema with the inventory in both directions. Pure; the test supplies the discovery. */
export function compareInventory(discovered: readonly DiscoveredTable[], tables: Readonly<Record<string, TableSink>> = TABLES): InventoryGap[] {
  const gaps: InventoryGap[] = [];
  const known = new Map(discovered.map((d) => [d.table, d]));
  for (const d of discovered) {
    const entry = tables[d.table];
    if (!entry) { gaps.push({ kind: "table_missing", table: d.table }); continue; }
    for (const c of d.columns) if (!(c in entry.columns)) gaps.push({ kind: "column_missing", table: d.table, column: c });
  }
  for (const [table, entry] of Object.entries(tables)) {
    const d = known.get(table);
    if (!d) { gaps.push({ kind: "table_stale", table }); continue; }
    for (const c of Object.keys(entry.columns)) if (!d.columns.includes(c)) gaps.push({ kind: "column_stale", table, column: c });
  }
  return gaps;
}

/** Sealed columns, for the at-rest census. */
export function sealedColumns(): { table: string; column: string; purpose: string; scheme: SealScheme }[] {
  const out: { table: string; column: string; purpose: string; scheme: SealScheme }[] = [];
  for (const [table, entry] of Object.entries(TABLES))
    for (const [column, sink] of Object.entries(entry.columns))
      if (sink.protection.kind === "sealed") out.push({ table, column, purpose: sink.protection.purpose, scheme: sink.protection.scheme });
  return out;
}
