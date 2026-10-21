-- Zenith platform control store (ADR-0002) — schema `platform`.
--
-- GENERATED FILE — DO NOT EDIT.
-- Source:      src/lib/controlplane/db/migrations/*.ts
-- Regenerate:  npx tsx scripts/platform/emit-sql.ts
-- Verified by: tests/controlplane/migrations.test.ts (byte-for-byte)
--
-- Applied by the operator (Supabase SQL editor, or psql against
-- ZENITH_PLATFORM_DB_URL) or by `npx tsx scripts/platform/migrate.ts`, which
-- reaches the same end state through the same ledger. Idempotent: re-applying
-- is a no-op. The application never runs DDL against Postgres; it checks
-- `platform.schema_migrations` on start and refuses to run when it is behind.
--
-- Row level security is ON for every table with NO policies: the service role
-- bypasses RLS and is the only identity that reads or writes these tables.
-- `platform` must never be added to the Data API's exposed schemas.

create schema if not exists platform;

create table if not exists platform.schema_migrations (
  version    integer     not null primary key,
  name       text        not null,
  applied_at timestamptz not null default now(),
  checksum   text        not null check (checksum ~ '^[0-9a-f]{64}$')
);

-- ============================ migration 1: core ============================

/* ------------------------------- operations -------------------------------- */

create table if not exists platform.operations (
  seq               bigint generated always as identity,
  id                text        not null primary key,
  workspace_id      text        not null,
  project_id        text,
  environment_id    text,
  resource_id       text,
  capability        text        not null,
  principal         jsonb       not null,
  status            text        not null check (status in (
                      'proposed','awaiting_approval','approved','rejected','denied',
                      'queued','running','succeeded','failed','uncertain','cancelled','expired')),
  proposal          jsonb       not null,
  proposal_digest   text        not null check (proposal_digest ~ '^[0-9a-f]{64}$'),
  input_digest      text        not null check (input_digest ~ '^[0-9a-f]{64}$'),
  plan_digest       text,
  policy_decision_id text,
  approval_required boolean     not null default false,
  idempotency_key   text,
  workflow_id       text,
  runner_job_id     text,
  -- the environment lease this execution runs under, and its fence token
  lease_scope       text,
  fence_token       bigint,
  -- the execution's own heartbeat: a running operation past lease_until is uncertain
  lease_holder      text,
  lease_until       timestamptz,
  correlation_id    text        not null,
  result            jsonb,
  error             text,
  created_at        timestamptz not null default clock_timestamp(),
  updated_at        timestamptz not null default clock_timestamp(),
  started_at        timestamptz,
  finished_at       timestamptz,
  expires_at        timestamptz not null,
  unique (seq),
  unique (workspace_id, id)
);
create index if not exists operations_ws_seq      on platform.operations (workspace_id, seq desc);
create index if not exists operations_ws_env_seq  on platform.operations (workspace_id, environment_id, seq desc);
create index if not exists operations_ws_status   on platform.operations (workspace_id, status);
create index if not exists operations_running     on platform.operations (lease_until) where status = 'running';
create index if not exists operations_pending_expiry
  on platform.operations (expires_at) where status in ('proposed','awaiting_approval','approved','queued');

/* ----------------------------- idempotency keys ----------------------------- */

create table if not exists platform.idempotency_keys (
  workspace_id text        not null,
  key          text        not null,
  request_hash text        not null,
  operation_id text,
  response     jsonb,
  created_at   timestamptz not null default clock_timestamp(),
  expires_at   timestamptz not null,
  primary key (workspace_id, key),
  -- deferred: the key row is claimed first, the operation row inserted after it
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id)
    deferrable initially deferred
);
create index if not exists idempotency_keys_expiry on platform.idempotency_keys (expires_at);

/* --------------------------------- leases ---------------------------------- */

-- One row per scope, kept forever: fence_token must be strictly increasing per
-- scope, so a released or expired lease keeps its row (and its counter).
create table if not exists platform.leases (
  scope        text        not null primary key,
  workspace_id text,
  holder       text        not null,
  fence_token  bigint      not null check (fence_token >= 1),
  acquired_at  timestamptz not null default clock_timestamp(),
  renewed_at   timestamptz not null default clock_timestamp(),
  expires_at   timestamptz not null,
  released_at  timestamptz
);
create index if not exists leases_ws on platform.leases (workspace_id) where workspace_id is not null;

/* -------------------------------- approvals -------------------------------- */

create table if not exists platform.approvals (
  id              text        not null primary key,
  operation_id    text        not null,
  workspace_id    text        not null,
  proposal_digest text        not null check (proposal_digest ~ '^[0-9a-f]{64}$'),
  decision        text        not null check (decision in ('approve','reject')),
  approver        jsonb       not null,
  approver_id     text        not null,
  approver_role   text        not null check (approver_role in ('viewer','editor','admin')),
  reason          text,
  policy_version  text        not null,
  created_at      timestamptz not null default clock_timestamp(),
  expires_at      timestamptz not null,
  consumed_at     timestamptz,
  -- one decision per approver per operation
  unique (operation_id, approver_id),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id)
);
create index if not exists approvals_ws_op on platform.approvals (workspace_id, operation_id);

/* ---------------------------- policy decisions ----------------------------- */

create table if not exists platform.policy_decisions (
  id             text        not null primary key,
  workspace_id   text        not null,
  operation_id   text,
  policy_version text        not null,
  input_digest   text        not null check (input_digest ~ '^[0-9a-f]{64}$'),
  outcome        text        not null check (outcome in ('allow','deny','require_approval')),
  reasons        jsonb       not null default '[]'::jsonb,
  approval       jsonb,
  constraints    jsonb,
  evaluated_at   timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id)
);
create index if not exists policy_decisions_ws_op on platform.policy_decisions (workspace_id, operation_id);

/* ---------------------------- capability grants ---------------------------- */

create table if not exists platform.capability_grants (
  jti          text        not null primary key,
  workspace_id text        not null,
  operation_id text        not null,
  capability   text        not null,
  audience     text        not null,
  issued_at    timestamptz not null,
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  revoked_at   timestamptz,
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id)
);
create index if not exists capability_grants_ws_op on platform.capability_grants (workspace_id, operation_id);

/* ---------------------------------- events --------------------------------- */

create table if not exists platform.events (
  seq            bigint generated always as identity primary key,
  id             text        not null unique,
  ts             timestamptz not null default clock_timestamp(),
  type           text        not null,
  workspace_id   text        not null,
  project_id     text,
  environment_id text,
  resource_id    text,
  operation_id   text,
  correlation_id text        not null,
  causation_id   text,
  actor          jsonb,
  data           jsonb       not null default '{}'::jsonb
);
create index if not exists events_ws_seq  on platform.events (workspace_id, seq);
create index if not exists events_ws_op   on platform.events (workspace_id, operation_id, seq) where operation_id is not null;
create index if not exists events_ws_corr on platform.events (workspace_id, correlation_id, seq);

/* --------------------------------- evidence -------------------------------- */

create table if not exists platform.evidence (
  id           text        not null primary key,
  workspace_id text        not null,
  operation_id text,
  incident_id  text,
  kind         text        not null check (kind in (
                 'tofu_plan','tofu_apply','observation','verification','http_probe','log_query',
                 'metric_query','policy_decision','build','machine_request','runner_job')),
  digest       text        not null check (digest ~ '^[0-9a-f]{64}$'),
  summary      jsonb       not null default '{}'::jsonb,
  blob_ref     text,
  simulated    boolean     not null,
  created_at   timestamptz not null default clock_timestamp()
);
create index if not exists evidence_ws_op  on platform.evidence (workspace_id, operation_id) where operation_id is not null;
create index if not exists evidence_ws_inc on platform.evidence (workspace_id, incident_id) where incident_id is not null;

/* ------------------------ environment / workspace policy -------------------- */

create table if not exists platform.environment_settings (
  environment_id text        not null primary key,
  workspace_id   text        not null,
  autonomy_level smallint    not null check (autonomy_level between 0 and 5),
  policy_params  jsonb       not null default '{}'::jsonb,
  version        integer     not null default 1,
  updated_by     text        not null,
  updated_at     timestamptz not null default clock_timestamp()
);
create index if not exists environment_settings_ws on platform.environment_settings (workspace_id);

create table if not exists platform.workspace_policy (
  workspace_id text        not null primary key,
  params       jsonb       not null default '{}'::jsonb,
  version      integer     not null default 1,
  updated_by   text        not null,
  updated_at   timestamptz not null default clock_timestamp()
);

/* --------------------------- provider connections -------------------------- */

create table if not exists platform.provider_connections (
  id                  text        not null primary key,
  workspace_id        text        not null,
  legacy_connection_id text,
  provider            text        not null,
  mode                text        not null,
  -- non-secret identifiers only (role ARNs, pool ids, tenant ids); never key material
  config              jsonb       not null,
  status              text        not null check (status in ('pending_verification','verified','failed','revoked')),
  verified_at         timestamptz,
  verification_detail text,
  created_by          text        not null,
  created_at          timestamptz not null default clock_timestamp(),
  revoked_at          timestamptz,
  unique (workspace_id, id)
);
create index if not exists provider_connections_ws on platform.provider_connections (workspace_id, created_at desc);

/* --------------------------------- resources ------------------------------- */

create table if not exists platform.resources (
  id             text        not null primary key,
  workspace_id   text        not null,
  project_id     text,
  environment_id text        not null,
  address        text        not null,
  kind           text        not null,
  provider       text        not null,
  region         text,
  native_type    text        not null,
  ownership      text        not null check (ownership in ('managed','referenced','external')),
  external_id    text,
  spec_digest    text        not null check (spec_digest ~ '^[0-9a-f]{64}$'),
  spec           jsonb       not null default '{}'::jsonb,
  depends_on     jsonb       not null default '[]'::jsonb,
  origin         jsonb       not null default '[]'::jsonb,
  labels         jsonb       not null default '{}'::jsonb,
  revision_id    text,
  status         text        not null default 'planned' check (status in (
                   'planned','provisioning','active','updating','deleting','deleted','failed','unknown')),
  created_at     timestamptz not null default clock_timestamp(),
  updated_at     timestamptz not null default clock_timestamp(),
  unique (environment_id, address),
  unique (workspace_id, id)
);
create index if not exists resources_ws_env on platform.resources (workspace_id, environment_id);

-- Observed state: append-only history, pruned to the latest N per resource.
create table if not exists platform.resource_observations (
  id           bigint generated always as identity primary key,
  resource_id  text        not null,
  workspace_id text        not null,
  environment_id text      not null,
  address      text        not null,
  presence     text        not null check (presence in ('present','missing','inaccessible','unknown')),
  external_id  text,
  attributes   jsonb       not null default '{}'::jsonb,
  native       jsonb,
  observed_at  timestamptz not null,
  source       text        not null,
  simulated    boolean     not null,
  error        text,
  recorded_at  timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, resource_id) references platform.resources (workspace_id, id) on delete cascade
);
create index if not exists resource_observations_latest
  on platform.resource_observations (resource_id, observed_at desc, id desc);
create index if not exists resource_observations_ws_env on platform.resource_observations (workspace_id, environment_id);

-- Runtime state: the latest per resource.
create table if not exists platform.resource_runtime (
  resource_id  text        not null primary key,
  workspace_id text        not null,
  environment_id text      not null,
  address      text        not null,
  health       text        not null check (health in ('healthy','degraded','unhealthy','unknown')),
  counts       jsonb       not null default '{}'::jsonb,
  signals      jsonb       not null default '[]'::jsonb,
  observed_at  timestamptz not null,
  source       text        not null,
  simulated    boolean     not null,
  updated_at   timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, resource_id) references platform.resources (workspace_id, id) on delete cascade
);
create index if not exists resource_runtime_ws_env on platform.resource_runtime (workspace_id, environment_id);

create table if not exists platform.drift_reports (
  id             text        not null primary key,
  workspace_id   text        not null,
  environment_id text        not null,
  graph_digest   text        not null,
  computed_at    timestamptz not null,
  findings       jsonb       not null default '[]'::jsonb,
  unobserved     jsonb       not null default '[]'::jsonb,
  simulated      boolean     not null,
  recorded_at    timestamptz not null default clock_timestamp()
);
create index if not exists drift_reports_env on platform.drift_reports (workspace_id, environment_id, computed_at desc);

/* ------------------------- runners, tokens, jobs, logs ---------------------- */

create table if not exists platform.runners (
  id                text        not null primary key,
  workspace_id      text        not null,
  name              text        not null,
  status            text        not null default 'active' check (status in ('active','revoked')),
  protocol          text        not null default 'zenith.runner/v1',
  public_key        text        not null,
  version           text,
  capabilities      jsonb       not null default '[]'::jsonb,
  labels            jsonb       not null default '{}'::jsonb,
  host              jsonb       not null default '{}'::jsonb,
  registered_at     timestamptz not null default clock_timestamp(),
  last_heartbeat_at timestamptz,
  revoked_at        timestamptz,
  unique (workspace_id, id)
);
create index if not exists runners_ws on platform.runners (workspace_id);

-- Only the SHA-256 of a registration token is ever stored.
create table if not exists platform.runner_registration_tokens (
  token_hash   text        not null primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  workspace_id text        not null,
  kind         text        not null check (kind in ('runner','machine')),
  binding      jsonb       not null default '{}'::jsonb,
  created_by   text        not null,
  created_at   timestamptz not null default clock_timestamp(),
  expires_at   timestamptz not null check (expires_at <= created_at + interval '61 minutes'),
  used_at      timestamptz,
  used_by      text
);
create index if not exists runner_registration_tokens_ws on platform.runner_registration_tokens (workspace_id);

create table if not exists platform.runner_jobs (
  id           text        not null primary key,   -- the signed envelope's jti
  runner_id    text        not null,
  workspace_id text        not null,
  operation_id text        not null,
  kind         text        not null,
  capability   text        not null,
  envelope     text        not null,
  status       text        not null default 'queued' check (status in (
                 'queued','claimed','running','succeeded','failed','rejected','timed_out','expired','cancelled')),
  lease_until  timestamptz,
  result       jsonb,
  error        text,
  created_at   timestamptz not null default clock_timestamp(),
  claimed_at   timestamptz,
  started_at   timestamptz,
  expires_at   timestamptz not null,
  settled_at   timestamptz,
  unique (workspace_id, id),
  foreign key (workspace_id, runner_id)    references platform.runners (workspace_id, id),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id)
);
create index if not exists runner_jobs_queue on platform.runner_jobs (runner_id, created_at, id) where status = 'queued';
create index if not exists runner_jobs_ws_op on platform.runner_jobs (workspace_id, operation_id);
create index if not exists runner_jobs_inflight on platform.runner_jobs (lease_until) where status in ('claimed','running');

create table if not exists platform.runner_job_logs (
  id           bigint generated always as identity primary key,
  job_id       text        not null,
  workspace_id text        not null,
  batch_seq    integer     not null,
  line_no      integer     not null,
  ts           timestamptz not null,
  stream       text        not null check (stream in ('stdout','stderr','info')),
  line         text        not null check (char_length(line) <= 8192),
  recorded_at  timestamptz not null default clock_timestamp(),
  -- a retried POST of the same batch does not duplicate lines
  unique (job_id, batch_seq, line_no),
  foreign key (workspace_id, job_id) references platform.runner_jobs (workspace_id, id) on delete cascade
);
create index if not exists runner_job_logs_ws_job on platform.runner_job_logs (workspace_id, job_id, id);

-- Replay protection for signed agent requests (RUNNER-PROTOCOL section 3).
create table if not exists platform.agent_nonces (
  agent_id text        not null,
  nonce    text        not null,
  seen_at  timestamptz not null default clock_timestamp(),
  primary key (agent_id, nonce)
);
create index if not exists agent_nonces_seen on platform.agent_nonces (seen_at);

/* ---------------------------------- machines ------------------------------- */

create table if not exists platform.machines (
  id                text        not null primary key,
  workspace_id      text        not null,
  environment_id    text,
  address           text,
  name              text        not null,
  transport         text        not null check (transport in (
                      'aws_ssm','kubernetes','azure_run_command','gcp_os_management','zenithd')),
  target_id         text        not null,
  status            text        not null default 'active' check (status in ('pending','active','revoked')),
  public_key        text,
  version           text,
  capabilities      jsonb       not null default '[]'::jsonb,
  labels            jsonb       not null default '{}'::jsonb,
  host              jsonb       not null default '{}'::jsonb,
  registered_at     timestamptz not null default clock_timestamp(),
  last_heartbeat_at timestamptz,
  revoked_at        timestamptz,
  unique (workspace_id, id),
  unique (workspace_id, transport, target_id)
);
create index if not exists machines_ws_env on platform.machines (workspace_id, environment_id);

/* ---------------------------- incidents, investigations -------------------- */

create table if not exists platform.incidents (
  id             text        not null primary key,
  workspace_id   text        not null,
  environment_id text,
  title          text        not null,
  status         text        not null default 'open' check (status in ('open','investigating','mitigating','resolved')),
  severity       text        not null check (severity in ('low','medium','high','critical')),
  source         text        not null,
  summary        text,
  correlation_id text        not null,
  document       jsonb       not null default '{}'::jsonb,
  opened_at      timestamptz not null default clock_timestamp(),
  updated_at     timestamptz not null default clock_timestamp(),
  resolved_at    timestamptz,
  unique (workspace_id, id)
);
create index if not exists incidents_ws_status on platform.incidents (workspace_id, status, opened_at desc);

create table if not exists platform.investigations (
  id             text        not null primary key,
  workspace_id   text        not null,
  incident_id    text,
  environment_id text        not null,
  started_at     timestamptz not null,
  finished_at    timestamptz not null,
  simulated      boolean     not null,
  -- the full Investigation value (path, evidence, hypotheses, recent changes)
  document       jsonb       not null,
  recorded_at    timestamptz not null default clock_timestamp()
);
create index if not exists investigations_ws_inc on platform.investigations (workspace_id, incident_id);
create index if not exists investigations_ws_env on platform.investigations (workspace_id, environment_id, started_at desc);

/* ------------------------------- cost estimates ---------------------------- */

create table if not exists platform.cost_estimates (
  id              text        not null primary key,
  workspace_id    text        not null,
  project_id      text,
  environment_id  text,
  operation_id    text,
  catalog_version text        not null,
  monthly_usd     double precision not null,
  -- the full CostEstimate value; always an estimate, never an invoice
  estimate        jsonb       not null,
  computed_at     timestamptz not null,
  recorded_at     timestamptz not null default clock_timestamp()
);
create index if not exists cost_estimates_ws_env on platform.cost_estimates (workspace_id, environment_id, computed_at desc);
create index if not exists cost_estimates_ws_op  on platform.cost_estimates (workspace_id, operation_id) where operation_id is not null;

insert into platform.schema_migrations (version, name, checksum)
values (1, 'core', 'ec4e2c1a7185e25ea6afa803e87abcc1fe8a06cb65651773f573f0b66de13764')
on conflict (version) do nothing;

-- ============================ migration 2: reconcile ============================

/* ----------------------------- reconcile state ----------------------------- */

create table if not exists platform.reconcile_state (
  environment_id       text        not null primary key,
  workspace_id         text        not null,
  project_id           text,
  -- descriptor: what the scheduler filters on (sandbox / no verified connection are not reconciled)
  env_class            text        not null check (env_class in ('sandbox','development','staging','production')),
  provider             text        not null,
  region               text        not null,
  connection_id        text,
  -- schedule: index into the backoff ladder (5 -> 15 -> 60 -> 180 min) and the next run
  step_index           integer     not null default 0 check (step_index >= 0),
  next_run_at          timestamptz not null,
  priority             integer     not null default 0,
  last_run_at          timestamptz,
  last_changed_at      timestamptz,
  last_deploy_at       timestamptz,
  last_graph_digest    text,
  last_outcome         text,
  consecutive_failures integer     not null default 0 check (consecutive_failures >= 0),
  -- the claim a pass holds while it reconciles this environment
  claimed_by           text,
  claimed_until        timestamptz,
  -- open findings: "<class>|<address>" -> first-seen timestamp (correlation ids)
  finding_since        jsonb       not null default '{}'::jsonb,
  registered_at        timestamptz not null,
  updated_at           timestamptz not null,
  unique (workspace_id, environment_id)
);
create index if not exists reconcile_state_due on platform.reconcile_state (next_run_at);
create index if not exists reconcile_state_ws on platform.reconcile_state (workspace_id);

create index if not exists operations_deploy_finished
  on platform.operations (finished_at)
  where status = 'succeeded' and capability in ('deployment.deploy', 'deployment.rollback', 'infrastructure.apply');

insert into platform.schema_migrations (version, name, checksum)
values (2, 'reconcile', 'af708ba78998ba35b05966afc4f037bacec9b38905853e6f43c8fdab92cb47f0')
on conflict (version) do nothing;

-- ============================ migration 3: machine_requests ============================

/* ------------------------ zenithd requests (mirror of runner_jobs) ------------------------ */

create table if not exists platform.machine_requests (
  id           text        not null primary key,   -- the signed envelope's jti (mreq_…)
  machine_id   text        not null,
  workspace_id text        not null,
  operation_id text        not null,
  operation    text        not null,               -- the machine operation (also the grant's capability)
  capability   text        not null,
  envelope     text        not null,
  status       text        not null default 'queued' check (status in (
                 'queued','claimed','running','succeeded','failed','rejected','timed_out','expired','cancelled')),
  lease_until  timestamptz,
  result       jsonb,
  error        text,
  created_at   timestamptz not null default clock_timestamp(),
  claimed_at   timestamptz,
  started_at   timestamptz,
  expires_at   timestamptz not null,
  settled_at   timestamptz,
  unique (workspace_id, id),
  foreign key (workspace_id, machine_id)   references platform.machines (workspace_id, id),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id)
);
create index if not exists machine_requests_queue on platform.machine_requests (machine_id, created_at, id) where status = 'queued';
create index if not exists machine_requests_ws_op on platform.machine_requests (workspace_id, operation_id);
create index if not exists machine_requests_inflight on platform.machine_requests (lease_until) where status in ('claimed','running');

create table if not exists platform.machine_request_logs (
  id           bigint generated always as identity primary key,
  request_id   text        not null,
  workspace_id text        not null,
  batch_seq    integer     not null,
  line_no      integer     not null,
  ts           timestamptz not null,
  stream       text        not null check (stream in ('stdout','stderr','info')),
  line         text        not null check (char_length(line) <= 8192),
  recorded_at  timestamptz not null default clock_timestamp(),
  unique (request_id, batch_seq, line_no),
  foreign key (workspace_id, request_id) references platform.machine_requests (workspace_id, id) on delete cascade
);
create index if not exists machine_request_logs_ws_req on platform.machine_request_logs (workspace_id, request_id, id);

insert into platform.schema_migrations (version, name, checksum)
values (3, 'machine_requests', 'e1eccac97c7852592bcad8cd0e441b67a442c7405735ee9e2619e9e9b100bec6')
on conflict (version) do nothing;

-- ============================ migration 4: approval_rounds ============================

alter table platform.operations
  add column if not exists approval_round integer not null default 0 check (approval_round >= 0);
alter table platform.approvals
  add column if not exists approval_round integer not null default 0 check (approval_round >= 0);
alter table platform.approvals
  drop constraint if exists approvals_operation_id_approver_id_key;
create unique index if not exists approvals_op_round_approver
  on platform.approvals (operation_id, approval_round, approver_id);

insert into platform.schema_migrations (version, name, checksum)
values (4, 'approval_rounds', '1e5d84e018bd35c3638bbd23bab8e5b0e7d9b6c3173a430259480508aca6f311')
on conflict (version) do nothing;

-- ============================ migration 5: read_jobs ============================

alter table platform.runner_jobs alter column operation_id drop not null;
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'platform.runner_jobs'::regclass
                    and conname = 'runner_jobs_read_capability') then
    alter table platform.runner_jobs add constraint runner_jobs_read_capability
      check (operation_id is not null or capability in ('infrastructure.observe', 'topology.read', 'logs.read', 'metrics.read', 'traces.read', 'events.read', 'incident.investigate', 'cost.estimate', 'firewall.inspect', 'infrastructure.plan', 'placement.solve', 'machine.inspect', 'process.list', 'service.status', 'container.list', 'container.inspect', 'container.logs', 'file.read', 'network.portCheck', 'network.dnsCheck', 'system.metrics', 'system.logs'));
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'platform.runner_jobs'::regclass
                    and conname = 'runner_jobs_read_expiry') then
    alter table platform.runner_jobs add constraint runner_jobs_read_expiry
      check (operation_id is not null or expires_at <= created_at + interval '1 hour');
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (5, 'read_jobs', 'e8349e5ddf50a5396304850bd84bbffe81be1f4b0b7189677c1c1ad36ad4a387')
on conflict (version) do nothing;

-- ============================ migration 6: github_sources ============================

create table if not exists platform.github_source_bindings (
  workspace_id text primary key,
  app_id text not null,
  installation_id bigint not null check (installation_id > 0),
  repository_id bigint not null check (repository_id > 0),
  owner text not null,
  repo text not null,
  version integer not null check (version > 0),
  bound_by text not null,
  updated_at timestamptz not null default clock_timestamp()
);
create table if not exists platform.github_install_intents (
  workspace_id text not null,
  state_digest text not null check (state_digest ~ '^[a-f0-9]{64}$'),
  actor_id text not null,
  browser_digest text not null check (browser_digest ~ '^[a-f0-9]{64}$'),
  owner text not null,
  repo text not null,
  expected_version integer not null check (expected_version >= 0),
  installation_id bigint,
  phase text not null check (phase in ('install', 'oauth')),
  expires_at timestamptz not null,
  primary key (workspace_id, state_digest)
);

insert into platform.schema_migrations (version, name, checksum)
values (6, 'github_sources', '0e256ace8f784b996b2e6687dc42bb4705f91c4579b4ecb1da38987d9f68d78d')
on conflict (version) do nothing;

-- ============================ migration 7: plan_artifacts ============================

create table if not exists platform.plan_artifacts (
  workspace_id text not null,
  operation_id text not null,
  manifest jsonb not null,
  manifest_digest text not null check (manifest_digest ~ '^[a-f0-9]{64}$'),
  plan_digest text not null check (plan_digest ~ '^[a-f0-9]{64}$'),
  iv text not null check (length(iv) = 16),
  auth_tag text not null check (length(auth_tag) = 24),
  ciphertext text not null check (length(ciphertext) between 1 and 30000000),
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, operation_id),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id),
  check (manifest->>'workspaceId' = workspace_id and manifest->>'operationId' = operation_id and manifest->>'planDigest' = plan_digest)
);
create table if not exists platform.plan_artifact_associations (
  workspace_id text not null,
  operation_id text not null,
  source_operation_id text not null,
  source_evidence_id text not null,
  source_manifest_digest text not null,
  source_raw_sha256 text not null,
  proposal_digest text not null,
  input_digest text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, operation_id),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id),
  foreign key (workspace_id, source_operation_id) references platform.plan_artifacts (workspace_id, operation_id),
  check (operation_id <> source_operation_id)
);
create table if not exists platform.plan_artifact_uses (
  workspace_id text not null,
  operation_id text not null,
  phase text not null default 'ready' check (phase in ('ready','claimed','dispatched','succeeded','uncertain','expired')),
  attempt_id text,
  holder text,
  fence_token bigint,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, operation_id),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id)
);
create or replace function platform.immutable_plan_artifact() returns trigger language plpgsql as $$
begin
  raise exception 'Immutable plan artifact cannot be modified or deleted' using errcode = '23514';
end
$$;
drop trigger if exists immutable_plan_artifact on platform.plan_artifacts;
create trigger immutable_plan_artifact before update or delete on platform.plan_artifacts
for each row execute function platform.immutable_plan_artifact();
drop trigger if exists immutable_plan_artifact_association on platform.plan_artifact_associations;
create trigger immutable_plan_artifact_association before update or delete on platform.plan_artifact_associations
for each row execute function platform.immutable_plan_artifact();
create index if not exists plan_artifacts_expiry on platform.plan_artifacts (expires_at);
-- Canonical schema-6 upgrades may use a different migration owner from the emitted bootstrap.
-- Harden only these new authority tables; existing/custom role policy remains operator-owned.
alter table platform.plan_artifacts enable row level security;
alter table platform.plan_artifact_associations enable row level security;
alter table platform.plan_artifact_uses enable row level security;
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema platform from %I', r);
      execute format('revoke all on table platform.plan_artifacts, platform.plan_artifact_associations, platform.plan_artifact_uses from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema platform to service_role;
    grant select, insert, update, delete on table platform.plan_artifacts, platform.plan_artifact_associations, platform.plan_artifact_uses to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (7, 'plan_artifacts', 'eb445d8479b4b8ba8c9c6e8df38fb95c3f9ca59f8949218e3c07f68727f62ae3')
on conflict (version) do nothing;

-- ============================ migration 8: build_launches ============================

create table if not exists platform.build_launches (
  workspace_id text not null,
  operation_id text not null,
  service_address text not null,
  environment_id text not null,
  attempt_id text not null,
  binding jsonb not null check (jsonb_typeof(binding) = 'object'),
  binding_digest text not null check (binding_digest ~ '^[a-f0-9]{64}$'),
  proposal_digest text not null check (proposal_digest ~ '^[a-f0-9]{64}$'),
  input_digest text not null check (input_digest ~ '^[a-f0-9]{64}$'),
  plan_digest text not null check (plan_digest ~ '^[a-f0-9]{64}$'),
  fence_token bigint not null,
  phase text not null default 'dispatched' check (phase in ('dispatched','accepted','terminal')),
  build_id text,
  request_ids jsonb,
  terminal_status text check (terminal_status in ('SUCCEEDED','FAILED','FAULT','TIMED_OUT','STOPPED')),
  provider_finished_at timestamptz,
  terminal_request_id text,
  created_at timestamptz not null default clock_timestamp(),
  accepted_at timestamptz,
  observed_at timestamptz,
  primary key (workspace_id, operation_id, service_address),
  unique (workspace_id, build_id),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id),
  check (binding ?& array['workspaceId','operationId','environmentId','serviceAddress']
    and binding->>'workspaceId' = workspace_id and binding->>'operationId' = operation_id
    and binding->>'environmentId' = environment_id and binding->>'serviceAddress' = service_address),
  check ((phase = 'dispatched' and build_id is null and request_ids is null and accepted_at is null)
    or (phase in ('accepted','terminal') and build_id is not null and accepted_at is not null and request_ids is not null
      and jsonb_typeof(request_ids) = 'array' and jsonb_array_length(request_ids) > 0)),
  check ((phase <> 'terminal' and terminal_status is null and provider_finished_at is null and terminal_request_id is null and observed_at is null)
    or (phase = 'terminal' and terminal_status is not null and provider_finished_at is not null and terminal_request_id is not null and observed_at is not null))
);
create or replace function platform.immutable_build_launch() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Build launch inventory cannot be deleted' using errcode = '23514';
  end if;
  if (to_jsonb(NEW) - array['phase','build_id','request_ids','accepted_at','terminal_status','provider_finished_at','terminal_request_id','observed_at'])
    is distinct from (to_jsonb(OLD) - array['phase','build_id','request_ids','accepted_at','terminal_status','provider_finished_at','terminal_request_id','observed_at'])
    or (OLD.phase = 'dispatched' and NEW.phase not in ('dispatched','accepted'))
    or (OLD.phase = 'accepted' and NEW.phase not in ('accepted','terminal'))
    or (OLD.phase = 'terminal' and to_jsonb(NEW) is distinct from to_jsonb(OLD))
    or (OLD.build_id is not null and (NEW.build_id is distinct from OLD.build_id
      or NEW.request_ids is distinct from OLD.request_ids or NEW.accepted_at is distinct from OLD.accepted_at)) then
    raise exception 'Build launch identity and receipts are immutable' using errcode = '23514';
  end if;
  return NEW;
end
$$;
drop trigger if exists immutable_build_launch on platform.build_launches;
create trigger immutable_build_launch before update or delete on platform.build_launches
for each row execute function platform.immutable_build_launch();
create index if not exists build_launches_environment on platform.build_launches (workspace_id, environment_id, phase);
alter table platform.build_launches enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table platform.build_launches from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema platform to service_role;
    grant select, insert, update on table platform.build_launches to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (8, 'build_launches', '90a025fd0c76ee84b14a26c9d8b1794e215ececec24333848904c22bc0f86e9d')
on conflict (version) do nothing;

-- ============================ migration 9: github_revocation ============================

alter table platform.github_source_bindings add column if not exists revoked_at timestamptz;
alter table platform.github_source_bindings add column if not exists revoked_by text;
create table if not exists platform.github_binding_events (
  workspace_id text not null,
  version integer not null check (version > 0),
  action text not null check (action in ('bound', 'revoked')),
  actor_id text not null,
  app_id text not null,
  installation_id bigint not null check (installation_id > 0),
  repository_id bigint not null check (repository_id > 0),
  owner text not null,
  repo text not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, version),
  foreign key (workspace_id) references platform.github_source_bindings (workspace_id)
);
-- This table records changes after this migration, never reconstructed history.
alter table platform.github_binding_events enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table platform.github_binding_events from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert on table platform.github_binding_events to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (9, 'github_revocation', '7d00eb79279b57c682dda67af0a5eaffc5ff3825d5e6a370235dd0dfdb502060')
on conflict (version) do nothing;

-- ============================ migration 10: github_deliveries ============================

-- Old callbacks have no signed-event fence. Integration must refuse their
-- OAuth transition/consumption until a new browser intent is authorized.
alter table platform.github_install_intents add column if not exists app_id text
  check (app_id ~ '^[1-9][0-9]{0,15}$');
alter table platform.github_install_intents add column if not exists installation_generation bigint
  check (installation_generation >= 0);
create table if not exists platform.github_webhook_installation_epochs (
  app_id text not null check (app_id ~ '^[1-9][0-9]{0,15}$'),
  installation_id bigint not null check (installation_id > 0),
  generation bigint not null default 0 check (generation >= 0),
  primary key (app_id, installation_id)
);
create table if not exists platform.github_webhook_deliveries (
  app_id text not null check (app_id ~ '^[1-9][0-9]{0,15}$'),
  delivery_id text not null check (delivery_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  body_sha256 text not null check (body_sha256 ~ '^[a-f0-9]{64}$'),
  event text not null,
  action text not null,
  installation_id bigint not null check (installation_id > 0),
  repository_ids bigint[] not null,
  revoked_count integer not null default 0 check (revoked_count >= 0),
  replayed boolean not null default false,
  received_at timestamptz not null default clock_timestamp(),
  primary key (app_id, delivery_id),
  check ((event = 'installation' and action in ('deleted', 'suspend') and cardinality(repository_ids) = 0)
    or (event = 'installation_repositories' and action = 'removed' and cardinality(repository_ids) between 1 and 1000)),
  check (0 < all(repository_ids))
);
-- Signed body replay may change the unsigned delivery GUID. The installation
-- epoch lock serializes digest checks; aliases retain their own durable receipt.
create index if not exists github_webhook_deliveries_body
  on platform.github_webhook_deliveries (app_id, body_sha256);
alter table platform.github_webhook_installation_epochs enable row level security;
alter table platform.github_webhook_deliveries enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table platform.github_webhook_installation_epochs, platform.github_webhook_deliveries from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update on table platform.github_webhook_installation_epochs, platform.github_webhook_deliveries to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (10, 'github_deliveries', 'a4436e385563b8bd3b3528708b1db757c5a9872e1927dbd8ef5bd595e1e62bfd')
on conflict (version) do nothing;

-- ============================ migration 11: agent_effect_receipts ============================

create table if not exists platform.agent_effect_receipts (
  workspace_id text not null check (workspace_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  agent_kind text not null check (agent_kind in ('runner','machine')),
  agent_id text not null check (agent_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  job_id text not null check (job_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  runner_job_id text,
  machine_request_id text,
  operation_id text check (operation_id is null or operation_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  job_kind text not null check (job_kind ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  capability text not null check (capability ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  envelope_digest text not null check (envelope_digest ~ '^[a-f0-9]{64}$'),
  agent_key_digest text not null check (agent_key_digest ~ '^[a-f0-9]{64}$'),
  logical_digest text not null check (logical_digest ~ '^[a-f0-9]{64}$'),
  projection_status text not null check (projection_status in ('claimed','running','cancelled','timed_out')),
  reported_status text not null check (reported_status in ('succeeded','failed','rejected','timed_out')),
  claimed_at timestamptz not null,
  received_at timestamptz not null default clock_timestamp(),
  sealed jsonb not null check (
    jsonb_typeof(sealed) = 'object' and sealed ?& array['v','alg','iv','ct','tag']
    and sealed - 'v' - 'alg' - 'iv' - 'ct' - 'tag' = '{}'::jsonb
    and sealed->'v' = '1'::jsonb and sealed->>'alg' = 'A256GCM'
    and jsonb_typeof(sealed->'alg') = 'string' and jsonb_typeof(sealed->'iv') = 'string'
    and jsonb_typeof(sealed->'tag') = 'string' and jsonb_typeof(sealed->'ct') = 'string'
    and sealed->>'iv' ~ '^[A-Za-z0-9_-]{16}$' and sealed->>'tag' ~ '^[A-Za-z0-9_-]{22}$'
    and sealed->>'ct' ~ '^[A-Za-z0-9_-]+$' and octet_length(sealed->>'ct') <= 22369626),
  primary key (workspace_id, agent_kind, job_id),
  check ((agent_kind = 'runner' and runner_job_id is not null and runner_job_id = job_id and machine_request_id is null)
      or (agent_kind = 'machine' and machine_request_id is not null and machine_request_id = job_id and runner_job_id is null)),
  foreign key (workspace_id, runner_job_id) references platform.runner_jobs (workspace_id, id),
  foreign key (workspace_id, machine_request_id) references platform.machine_requests (workspace_id, id)
);
create index if not exists agent_effect_receipts_ws_op on platform.agent_effect_receipts (workspace_id, operation_id);

create or replace function platform.agent_effect_receipt_immutable() returns trigger language plpgsql as $$
begin
  raise exception using errcode = '23514', message = 'Agent effect receipts cannot be changed or removed';
end $$;
drop trigger if exists agent_effect_receipt_immutable on platform.agent_effect_receipts;
create trigger agent_effect_receipt_immutable before update or delete on platform.agent_effect_receipts
  for each row execute function platform.agent_effect_receipt_immutable();

-- Original signed assignment and the first durable claim remain immutable.
create or replace function platform.runner_assignment_immutable() returns trigger language plpgsql as $$
begin
  if row(new.id,new.workspace_id,new.runner_id,new.operation_id,new.kind,new.capability,new.envelope)
     is distinct from row(old.id,old.workspace_id,old.runner_id,old.operation_id,old.kind,old.capability,old.envelope)
     or (old.claimed_at is not null and new.claimed_at is distinct from old.claimed_at) then
    raise exception using errcode = '23514', message = 'Original runner assignment cannot be changed';
  end if;
  return new;
end $$;
drop trigger if exists runner_assignment_immutable on platform.runner_jobs;
create trigger runner_assignment_immutable before update on platform.runner_jobs
  for each row execute function platform.runner_assignment_immutable();

create or replace function platform.machine_assignment_immutable() returns trigger language plpgsql as $$
begin
  if row(new.id,new.workspace_id,new.machine_id,new.operation_id,new.operation,new.capability,new.envelope)
     is distinct from row(old.id,old.workspace_id,old.machine_id,old.operation_id,old.operation,old.capability,old.envelope)
     or (old.claimed_at is not null and new.claimed_at is distinct from old.claimed_at) then
    raise exception using errcode = '23514', message = 'Original machine assignment cannot be changed';
  end if;
  return new;
end $$;
drop trigger if exists machine_assignment_immutable on platform.machine_requests;
create trigger machine_assignment_immutable before update on platform.machine_requests
  for each row execute function platform.machine_assignment_immutable();

alter table platform.agent_effect_receipts enable row level security;
do $$ declare r text; begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table platform.agent_effect_receipts from %I',r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    -- The same creator can inherit older emitted default UPDATE/DELETE grants.
    revoke all on table platform.agent_effect_receipts from service_role;
    grant select, insert on table platform.agent_effect_receipts to service_role;
  end if;
end $$;

insert into platform.schema_migrations (version, name, checksum)
values (11, 'agent_effect_receipts', 'f6c9d90f69447e430ad9ef2b8368b137b26cadcd05776d689959c99da9e0430b')
on conflict (version) do nothing;

-- ============================ migration 12: workflow_start_intents ============================

create table if not exists platform.workflow_start_intents (
  workspace_id text not null,
  operation_id text not null,
  binding jsonb not null check (octet_length(binding::text) <= 16000),
  binding_digest text not null check (binding_digest ~ '^[a-f0-9]{64}$'),
  phase text not null default 'prepared' check (phase in ('prepared','attempted','acknowledged')),
  attempt_id text check (attempt_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  run_id text check (run_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  observed_start_at timestamptz,
  evidence_digest text check (evidence_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  attempted_at timestamptz,
  acknowledged_at timestamptz,
  primary key (workspace_id, operation_id),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id),
  check (binding->>'format' = 'zenith.workflow-start.v1'
    and binding->'arguments'->>'workspaceId' = workspace_id
    and binding->'arguments'->>'operationId' = operation_id),
  check ((phase = 'prepared' and attempt_id is null and attempted_at is null
      and run_id is null and observed_start_at is null and evidence_digest is null and acknowledged_at is null)
    or (phase = 'attempted' and attempt_id is not null and attempted_at is not null
      and run_id is null and observed_start_at is null and evidence_digest is null and acknowledged_at is null)
    or (phase = 'acknowledged' and attempt_id is not null and attempted_at is not null
      and run_id is not null and observed_start_at is not null and evidence_digest is not null and acknowledged_at is not null))
);
create unique index if not exists workflow_start_intents_temporal_identity on platform.workflow_start_intents
  ((binding->>'endpointDigest'), (binding->>'namespace'), (binding->>'workflowId'));
create or replace function platform.retain_workflow_start_intent() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Workflow start tombstones cannot be deleted' using errcode = '23514';
  end if;
  if (new.workspace_id, new.operation_id, new.binding, new.binding_digest, new.created_at)
    is distinct from (old.workspace_id, old.operation_id, old.binding, old.binding_digest, old.created_at)
    or (old.attempt_id is not null and (new.attempt_id, new.attempted_at) is distinct from (old.attempt_id, old.attempted_at))
    or (old.phase = 'acknowledged' and new is distinct from old)
    or not ((old.phase = 'prepared' and new.phase = 'attempted')
      or (old.phase = 'attempted' and new.phase = 'acknowledged') or new is not distinct from old) then
    raise exception 'Workflow start intent is immutable and cannot be replayed' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists retain_workflow_start_intent on platform.workflow_start_intents;
create trigger retain_workflow_start_intent before update or delete on platform.workflow_start_intents
for each row execute function platform.retain_workflow_start_intent();
alter table platform.workflow_start_intents enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table platform.workflow_start_intents from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema platform to service_role;
    -- Creator defaults may include TRUNCATE, which bypasses every row trigger.
    -- Remove the complete inherited table grant before admitting only phase DML.
    revoke all on table platform.workflow_start_intents from service_role;
    grant select, insert, update on table platform.workflow_start_intents to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (12, 'workflow_start_intents', '7eaa5e87e594d741e772e0cd9b77010c796d36c2c9ceac41f8f47720c804d811')
on conflict (version) do nothing;

-- ============================ migration 13: approved_source_snapshots ============================

create table if not exists platform.approved_source_snapshots (
  workspace_id text not null,
  operation_id text not null,
  project_id text not null,
  environment_id text not null,
  service_address text not null check (service_address ~ '^[a-z_]+/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$'),
  snapshot jsonb not null check (jsonb_typeof(snapshot)='object' and octet_length(snapshot::text)<=16000),
  snapshot_digest text not null check (snapshot_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id,operation_id,service_address),
  foreign key (workspace_id,operation_id) references platform.operations(workspace_id,id),
  check ((snapshot ?& array['format','workspaceId','operationId','projectId','environmentId','serviceAddress','serviceSpecDigest','pipelineAddress','pipelineSpecDigest','provider','region','owner','repo','repositoryId','requestedRef','commitSha','githubBinding','dockerfile','dockerfileDigest','recipeDigest','archiveFormat','archiveDigest','archiveBytes']
    and snapshot - array['format','workspaceId','operationId','projectId','environmentId','serviceAddress','serviceSpecDigest','pipelineAddress','pipelineSpecDigest','provider','region','owner','repo','repositoryId','requestedRef','commitSha','githubBinding','dockerfile','dockerfileDigest','recipeDigest','archiveFormat','archiveDigest','archiveBytes']='{}'::jsonb
    and jsonb_typeof(snapshot->'format')='string'
    and jsonb_typeof(snapshot->'workspaceId')='string'
    and jsonb_typeof(snapshot->'operationId')='string'
    and jsonb_typeof(snapshot->'projectId')='string'
    and jsonb_typeof(snapshot->'environmentId')='string'
    and jsonb_typeof(snapshot->'serviceAddress')='string'
    and jsonb_typeof(snapshot->'serviceSpecDigest')='string'
    and jsonb_typeof(snapshot->'pipelineAddress')='string'
    and jsonb_typeof(snapshot->'pipelineSpecDigest')='string'
    and jsonb_typeof(snapshot->'provider')='string'
    and jsonb_typeof(snapshot->'region')='string'
    and jsonb_typeof(snapshot->'owner')='string'
    and jsonb_typeof(snapshot->'repo')='string'
    and jsonb_typeof(snapshot->'requestedRef')='string'
    and jsonb_typeof(snapshot->'commitSha')='string'
    and jsonb_typeof(snapshot->'dockerfile')='string'
    and jsonb_typeof(snapshot->'dockerfileDigest')='string'
    and jsonb_typeof(snapshot->'recipeDigest')='string'
    and jsonb_typeof(snapshot->'archiveFormat')='string'
    and jsonb_typeof(snapshot->'archiveDigest')='string'
    and snapshot->>'format'='zenith.approved-source.v1'
    and workspace_id ~ '^[A-Za-z0-9_.:-]{1,200}$' and operation_id ~ '^[A-Za-z0-9_.:-]{1,200}$'
    and project_id ~ '^[A-Za-z0-9_.:-]{1,200}$' and environment_id ~ '^[A-Za-z0-9_.:-]{1,200}$'
    and snapshot->>'workspaceId'=workspace_id and snapshot->>'operationId'=operation_id
    and snapshot->>'projectId'=project_id and snapshot->>'environmentId'=environment_id
    and snapshot->>'serviceAddress'=service_address
    and snapshot->>'commitSha' ~ '^[a-f0-9]{40}$'
    and snapshot->>'archiveDigest' ~ '^[a-f0-9]{64}$'
    and snapshot->>'dockerfileDigest' ~ '^[a-f0-9]{64}$'
    and snapshot->>'recipeDigest' ~ '^[a-f0-9]{64}$'
    and snapshot->>'serviceSpecDigest' ~ '^[a-f0-9]{64}$'
    and snapshot->>'pipelineSpecDigest' ~ '^[a-f0-9]{64}$'
    and snapshot->>'provider' in ('aws','gcp','azure')
    and snapshot->>'archiveFormat'=case when snapshot->>'provider'='aws' then 'zip' else 'tar.gz' end
    and jsonb_typeof(snapshot->'repositoryId')='number'
    and (snapshot->>'repositoryId')::numeric between 1 and 9007199254740991
    and jsonb_typeof(snapshot->'archiveBytes')='number'
    and (snapshot->>'archiveBytes')::numeric between 1 and 33554432
    and snapshot->>'repositoryId' ~ '^[1-9][0-9]{0,15}$' and snapshot->>'archiveBytes' ~ '^[1-9][0-9]{0,7}$'
    and snapshot->>'pipelineAddress' ~ '^[a-z_]+/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$'
    and snapshot->>'owner' ~ '^[a-z0-9][a-z0-9-]{0,38}$' and snapshot->>'repo' ~ '^[a-z0-9._-]{1,100}$' and snapshot->>'repo' not in ('.','..')
    and snapshot->>'region' ~ '^[A-Za-z0-9_.:-]{1,200}$'
    and length(snapshot->>'requestedRef') between 1 and 250 and snapshot->>'requestedRef' ~ '^[A-Za-z0-9._+@~-]{1,100}(/[A-Za-z0-9._+@~-]{1,100})*$'
    and snapshot->>'requestedRef' !~ '(^|/)[.]{1,2}(/|$)'
    and length(snapshot->>'dockerfile') between 1 and 200 and snapshot->>'dockerfile' ~ '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$'
    and position('..' in snapshot->>'dockerfile')=0 and snapshot->>'dockerfile' !~ '(^|/)[.](/|$)'
    and (snapshot->'githubBinding'='null'::jsonb or (
      jsonb_typeof(snapshot->'githubBinding')='object'
      and snapshot->'githubBinding' ?& array['appId','installationId','repositoryId','version']
      and (snapshot->'githubBinding') - array['appId','installationId','repositoryId','version']='{}'::jsonb
      and jsonb_typeof(snapshot->'githubBinding'->'appId')='string' and snapshot->'githubBinding'->>'appId' ~ '^[1-9][0-9]{0,15}$'
      and jsonb_typeof(snapshot->'githubBinding'->'installationId')='number' and snapshot->'githubBinding'->>'installationId' ~ '^[1-9][0-9]{0,15}$'
      and (snapshot->'githubBinding'->>'installationId')::numeric<=9007199254740991
      and snapshot->'githubBinding'->'repositoryId'=snapshot->'repositoryId'
      and jsonb_typeof(snapshot->'githubBinding'->'version')='number' and snapshot->'githubBinding'->>'version' ~ '^[1-9][0-9]{0,15}$'
      and (snapshot->'githubBinding'->>'version')::numeric<=9007199254740991
    ))) is true)
);
create or replace function platform.retain_approved_source_snapshot() returns trigger language plpgsql as $$
begin
  if TG_OP='TRUNCATE' or TG_OP='DELETE' or (TG_OP='UPDATE' and new is distinct from old) then
    raise exception 'Approved source records are immutable' using errcode='23514';
  end if;
  return new;
end $$;
drop trigger if exists retain_approved_source_snapshot on platform.approved_source_snapshots;
create trigger retain_approved_source_snapshot before update or delete on platform.approved_source_snapshots
for each row execute function platform.retain_approved_source_snapshot();
drop trigger if exists retain_approved_source_snapshot_truncate on platform.approved_source_snapshots;
create trigger retain_approved_source_snapshot_truncate before truncate on platform.approved_source_snapshots
for each statement execute function platform.retain_approved_source_snapshot();
alter table platform.approved_source_snapshots enable row level security;
revoke all on platform.approved_source_snapshots from public;
do $$ declare r text; begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.approved_source_snapshots from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on platform.approved_source_snapshots from service_role;
    grant select,insert on platform.approved_source_snapshots to service_role;
  end if;
end $$;

insert into platform.schema_migrations (version, name, checksum)
values (13, 'approved_source_snapshots', 'eb513c01d41b1f7fbc680715b86699147374d9786aa3e17e355897388ff26e95')
on conflict (version) do nothing;

-- ============================ migration 14: mixed_child_intents ============================

create table if not exists platform.mixed_child_custody (
  workspace_id text not null,
  parent_operation_id text not null,
  child_operation_id text not null,
  partition_id text not null check (partition_id ~ '^[a-f0-9]{64}$'),
  descriptor jsonb not null check (octet_length(descriptor::text) <= 131072),
  descriptor_digest text not null check (descriptor_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, child_operation_id),
  unique (workspace_id, parent_operation_id, child_operation_id, descriptor_digest),
  foreign key (workspace_id, parent_operation_id) references platform.operations(workspace_id,id),
  foreign key (workspace_id, child_operation_id) references platform.operations(workspace_id,id),
  check (parent_operation_id <> child_operation_id),
  check (coalesce((descriptor->>'format' = 'zenith.mixed-child-candidate.v1'
    and descriptor->>'workspaceId' = workspace_id
    and descriptor->'parent'->>'operationId' = parent_operation_id
    and descriptor->'child'->>'operationId' = child_operation_id
    and descriptor->>'partitionId' = partition_id
    and descriptor->'executionEnabled' = 'false'::jsonb
    and descriptor->>'parentEffectCoverage' = 'unsupported'
    and descriptor->>'compilerReferenceCoverage' = 'unavailable'
    and descriptor->'artifactBytesAuthenticated' = 'false'::jsonb
    and descriptor->>'connectionAuthorization' = 'not_minted'),false))
);
create table if not exists platform.mixed_child_intents (
  workspace_id text not null,
  parent_operation_id text not null,
  child_operation_id text not null,
  descriptor_digest text not null,
  phase text not null default 'prepared' check (phase in ('prepared','attempted','acknowledged')),
  attempt_id text check (attempt_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  run_id text check (run_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  receipt jsonb check (octet_length(receipt::text) <= 16000),
  created_at timestamptz not null default clock_timestamp(),
  attempted_at timestamptz,
  acknowledged_at timestamptz,
  primary key (workspace_id,child_operation_id),
  foreign key (workspace_id,parent_operation_id,child_operation_id,descriptor_digest)
    references platform.mixed_child_custody(workspace_id,parent_operation_id,child_operation_id,descriptor_digest),
  check (coalesce(((phase='prepared' and attempt_id is null and run_id is null and receipt is null and attempted_at is null and acknowledged_at is null)
    or (phase='attempted' and attempt_id is not null and attempted_at is not null and run_id is null and receipt is null and acknowledged_at is null)
    or (phase='acknowledged' and attempt_id is not null and attempted_at is not null and run_id is not null and receipt is not null and acknowledged_at is not null
      and receipt->>'format'='zenith.mixed-child-history.v1'
      and receipt->>'workspaceId'=workspace_id and receipt->>'parentOperationId'=parent_operation_id
      and receipt->>'childOperationId'=child_operation_id and receipt->>'descriptorDigest'=descriptor_digest
      and receipt->>'attemptId'=attempt_id and receipt->>'runId'=run_id)),false))
);
create or replace function platform.immutable_mixed_child_custody() returns trigger language plpgsql as $$
begin
  raise exception 'Mixed child custody is immutable' using errcode='23514';
end
$$;
drop trigger if exists immutable_mixed_child_custody on platform.mixed_child_custody;
create trigger immutable_mixed_child_custody before update or delete on platform.mixed_child_custody
for each row execute function platform.immutable_mixed_child_custody();
create or replace function platform.retain_mixed_child_intent() returns trigger language plpgsql as $$
begin
  if TG_OP='DELETE' then
    raise exception 'Mixed child attempt tombstones cannot be deleted' using errcode='23514';
  end if;
  if (new.workspace_id,new.parent_operation_id,new.child_operation_id,new.descriptor_digest,new.created_at)
    is distinct from (old.workspace_id,old.parent_operation_id,old.child_operation_id,old.descriptor_digest,old.created_at)
    or (old.attempt_id is not null and (new.attempt_id,new.attempted_at) is distinct from (old.attempt_id,old.attempted_at))
    or (old.phase='acknowledged' and new is distinct from old)
    or not ((old.phase='attempted' and new.phase='acknowledged') or new is not distinct from old) then
    -- No supported parent effects/browser-review representation exists yet.
    -- Even direct service-role UPDATE cannot promote a prepared candidate.
    raise exception 'Mixed child start is unsupported or nonreplayable' using errcode='23514';
  end if;
  return new;
end
$$;
drop trigger if exists retain_mixed_child_intent on platform.mixed_child_intents;
create trigger retain_mixed_child_intent before update or delete on platform.mixed_child_intents
for each row execute function platform.retain_mixed_child_intent();
alter table platform.mixed_child_custody enable row level security;
alter table platform.mixed_child_intents enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.mixed_child_custody,platform.mixed_child_intents from %I',r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname='service_role') then
    grant usage on schema platform to service_role;
    revoke all on table platform.mixed_child_custody,platform.mixed_child_intents from service_role;
    grant select,insert on table platform.mixed_child_custody to service_role;
    grant select,insert,update on table platform.mixed_child_intents to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (14, 'mixed_child_intents', '5d676658116c3e66b1238c24a72da4ddbd65f06f30c57cf5dc753bcc0a56961e')
on conflict (version) do nothing;

-- ============================ migration 15: cleanup_writer_barriers ============================

create table if not exists platform.cleanup_writer_epoch (
  singleton boolean primary key default true check (singleton),
  installed_at timestamptz not null default clock_timestamp()
);
insert into platform.cleanup_writer_epoch(singleton) values(true) on conflict do nothing;
-- Every scoped and unscoped writer takes this coordinator AFTER its existing row locks.
-- The exact environment holds are separate; unrelated scoped environments remain writable.
create table if not exists platform.cleanup_writer_scopes (
  workspace_id text primary key,
  created_at timestamptz not null default clock_timestamp()
);
create table if not exists platform.cleanup_writer_holds (
  workspace_id text not null,
  project_id text not null,
  environment_id text not null,
  operation_id text not null,
  attempt_id text not null,
  generation text not null check (generation ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'),
  manifest_digest text not null check (manifest_digest ~ '^[a-f0-9]{64}$'),
  authority_digest text not null check (authority_digest ~ '^[a-f0-9]{64}$'),
  holder text not null,
  fence_token bigint not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(workspace_id,project_id,environment_id),
  unique(workspace_id,operation_id,attempt_id,generation),
  foreign key(workspace_id,operation_id) references platform.operations(workspace_id,id)
);
create table if not exists platform.cleanup_writer_deliveries (
  workspace_id text not null,
  project_id text,
  environment_id text,
  operation_id text not null,
  family text not null check (family in ('workflow','plan','build','runner','machine','grant')),
  identity text not null,
  capability text not null,
  attempt_id text,
  created_at timestamptz not null default clock_timestamp(),
  primary key(workspace_id,family,identity)
);
create table if not exists platform.cleanup_owner_grants (
  workspace_id text not null,
  operation_id text not null,
  attempt_id text not null,
  generation text not null,
  jti text not null unique,
  capability text not null check (capability='infrastructure.destroy'),
  audience text not null check (audience='worker'),
  created_at timestamptz not null default clock_timestamp(),
  primary key(workspace_id,operation_id,attempt_id,generation),
  foreign key(workspace_id,operation_id,attempt_id,generation)
    references platform.cleanup_writer_holds(workspace_id,operation_id,attempt_id,generation)
);
create or replace function platform.immutable_cleanup_writer_history() returns trigger language plpgsql as $$
begin
  raise exception 'Cleanup history cannot be changed or cleared' using errcode='23514';
end
$$;
drop trigger if exists immutable_cleanup_epoch on platform.cleanup_writer_epoch;
create trigger immutable_cleanup_epoch before update or delete on platform.cleanup_writer_epoch
for each row execute function platform.immutable_cleanup_writer_history();
drop trigger if exists immutable_cleanup_scope on platform.cleanup_writer_scopes;
create trigger immutable_cleanup_scope before update or delete on platform.cleanup_writer_scopes
for each row execute function platform.immutable_cleanup_writer_history();
drop trigger if exists immutable_cleanup_hold on platform.cleanup_writer_holds;
create trigger immutable_cleanup_hold before update or delete on platform.cleanup_writer_holds
for each row execute function platform.immutable_cleanup_writer_history();
drop trigger if exists immutable_cleanup_delivery on platform.cleanup_writer_deliveries;
create trigger immutable_cleanup_delivery before update or delete on platform.cleanup_writer_deliveries
for each row execute function platform.immutable_cleanup_writer_history();
drop trigger if exists immutable_cleanup_owner_grant on platform.cleanup_owner_grants;
create trigger immutable_cleanup_owner_grant before update or delete on platform.cleanup_owner_grants
for each row execute function platform.immutable_cleanup_writer_history();

create or replace function platform.cleanup_scope_epoch_unknown(ws text,proj text,env text) returns boolean
language plpgsql stable security definer set search_path=pg_catalog,platform as $$
begin
  if to_regclass('public.environments') is null then return true; end if;
  return not exists(select 1 from public.environments e where e.workspace_id=ws and e.project_id=proj and e.id=env
    and e.created_at is not null and e.created_at >= (select installed_at from platform.cleanup_writer_epoch where singleton));
end
$$;
revoke all on function platform.cleanup_scope_epoch_unknown(text,text,text) from public;

create or replace function platform.cleanup_writer_transition() returns trigger
language plpgsql security definer set search_path=pg_catalog,platform as $$
declare
  o platform.operations%rowtype;
  h platform.cleanup_writer_holds%rowtype;
  ws text;
  opid text;
  family_name text;
  delivery_id text;
  delivery_cap text;
  delivery_attempt text;
  read_only_cap boolean;
begin
  ws:=new.workspace_id; opid:=new.operation_id;
  if TG_TABLE_NAME='workflow_start_intents' then
    if new.phase<>'attempted' or (TG_OP='UPDATE' and old.phase<>'prepared') then return new; end if;
    family_name:='workflow'; delivery_id:=opid || ':' || new.attempt_id; delivery_attempt:=new.attempt_id;
  elsif TG_TABLE_NAME='plan_artifact_uses' then
    if new.phase<>'dispatched' or (TG_OP='UPDATE' and old.phase<>'claimed') then return new; end if;
    family_name:='plan'; delivery_id:=opid || ':' || new.attempt_id; delivery_attempt:=new.attempt_id;
  elsif TG_TABLE_NAME='build_launches' then
    family_name:='build'; delivery_id:=opid || ':' || new.service_address || ':' || new.attempt_id;
  elsif TG_TABLE_NAME='runner_jobs' or TG_TABLE_NAME='machine_requests' then
    if new.status<>'running' or (TG_OP='UPDATE' and old.status='running') then return new; end if;
    family_name:=case when TG_TABLE_NAME='runner_jobs' then 'runner' else 'machine' end;
    delivery_id:=new.id; delivery_cap:=new.capability;
  elsif TG_TABLE_NAME='capability_grants' then
    family_name:='grant'; delivery_id:=new.jti; delivery_cap:=new.capability;
  else
    raise exception 'Unsupported cleanup writer' using errcode='23514';
  end if;
  if delivery_cap in ('infrastructure.plan','infrastructure.observe','topology.read','logs.read','metrics.read','traces.read',
    'events.read','incident.investigate','cost.estimate','firewall.inspect','placement.solve','machine.inspect','process.list',
    'service.status','container.list','container.inspect','container.logs','file.read','network.portCheck','network.dnsCheck','system.metrics','system.logs') then return new; end if;
  -- Every INSERT's operation FK must be acquired before the coordinator.
  -- UPDATE already owns its row and unchanged FK: do not add an op lock.
  if TG_OP='INSERT' then
    select * into o from platform.operations where workspace_id=ws and id=opid for key share;
  else
    select * into o from platform.operations where workspace_id=ws and id=opid;
  end if;
  if not found then raise exception 'Cleanup writer owner is unavailable' using errcode='23514'; end if;
  if o.workspace_id is distinct from o.proposal->'scope'->>'workspaceId'
    or o.project_id is distinct from o.proposal->'scope'->>'projectId'
    or o.environment_id is distinct from o.proposal->'scope'->>'environmentId' then
    raise exception 'Cleanup writer scope projection changed' using errcode='23514';
  end if;
  delivery_cap:=coalesce(delivery_cap,o.capability);
  read_only_cap:=delivery_cap in ('infrastructure.plan','infrastructure.observe','topology.read','logs.read','metrics.read','traces.read',
    'events.read','incident.investigate','cost.estimate','firewall.inspect','placement.solve','machine.inspect','process.list',
    'service.status','container.list','container.inspect','container.logs','file.read','network.portCheck','network.dnsCheck','system.metrics','system.logs');
  if read_only_cap and family_name<>'build' then return new; end if;
  insert into platform.cleanup_writer_scopes(workspace_id) values(ws) on conflict do nothing;
  perform workspace_id from platform.cleanup_writer_scopes where workspace_id=ws for update;
  select * into h from platform.cleanup_writer_holds where workspace_id=ws
    and (o.project_id is null or o.environment_id is null or (project_id=o.project_id and environment_id=o.environment_id)) limit 1;
  if found then
    if family_name='grant' and delivery_cap='infrastructure.destroy' and new.audience='worker'
      and exists(select 1 from platform.cleanup_owner_grants g join platform.plan_artifact_uses u
        on u.workspace_id=g.workspace_id and u.operation_id=g.operation_id
        where g.workspace_id=ws and g.operation_id=opid and g.jti=new.jti and g.attempt_id=h.attempt_id and g.generation=h.generation
          and u.phase='claimed' and u.attempt_id=h.attempt_id and u.holder=h.holder and u.fence_token=h.fence_token)
      and o.id=h.operation_id and o.status='running' and o.lease_until>clock_timestamp() and o.expires_at>clock_timestamp()
      and o.lease_holder='workflow:' || o.id and o.lease_scope='env:' || h.environment_id and o.fence_token=h.fence_token
      and exists(select 1 from platform.leases l where l.workspace_id=ws and l.scope=o.lease_scope and l.holder=h.holder
        and l.fence_token=h.fence_token and l.expires_at>clock_timestamp()) then
      delivery_attempt:=h.attempt_id;
    elsif family_name='plan' and o.id=h.operation_id and delivery_attempt=h.attempt_id
      and exists(select 1 from platform.cleanup_owner_grants g join platform.capability_grants c on c.jti=g.jti
        where g.workspace_id=ws and g.operation_id=opid and g.attempt_id=h.attempt_id and g.generation=h.generation
          and c.workspace_id=ws and c.operation_id=opid and c.capability='infrastructure.destroy' and c.audience='worker'
          and c.revoked_at is null and c.expires_at>clock_timestamp()) then
      null;
    else
      raise exception 'Cleanup hold refuses a new possible delivery' using errcode='23514';
    end if;
  elsif delivery_cap='infrastructure.destroy' and family_name in ('grant','plan') then
    -- Direct provider teardown cannot issue a bearer before an authenticated paired hold.
    raise exception 'Destroy requires a held authenticated attempt' using errcode='23514';
  end if;
  insert into platform.cleanup_writer_deliveries(workspace_id,project_id,environment_id,operation_id,family,identity,capability,attempt_id)
    values(ws,o.project_id,o.environment_id,opid,family_name,delivery_id,delivery_cap,delivery_attempt) on conflict do nothing;
  return new;
end
$$;
drop trigger if exists cleanup_workflow_writer on platform.workflow_start_intents;
create trigger cleanup_workflow_writer before insert or update of phase on platform.workflow_start_intents
for each row execute function platform.cleanup_writer_transition();
drop trigger if exists cleanup_plan_writer on platform.plan_artifact_uses;
create trigger cleanup_plan_writer before insert or update of phase on platform.plan_artifact_uses
for each row execute function platform.cleanup_writer_transition();
drop trigger if exists cleanup_build_writer on platform.build_launches;
create trigger cleanup_build_writer before insert on platform.build_launches
for each row execute function platform.cleanup_writer_transition();
drop trigger if exists cleanup_runner_writer on platform.runner_jobs;
create trigger cleanup_runner_writer before insert or update of status on platform.runner_jobs
for each row execute function platform.cleanup_writer_transition();
drop trigger if exists cleanup_machine_writer on platform.machine_requests;
create trigger cleanup_machine_writer before insert or update of status on platform.machine_requests
for each row execute function platform.cleanup_writer_transition();
drop trigger if exists cleanup_grant_writer on platform.capability_grants;
create trigger cleanup_grant_writer before insert on platform.capability_grants
for each row execute function platform.cleanup_writer_transition();
revoke all on function platform.cleanup_writer_transition() from public;
revoke all on function platform.immutable_cleanup_writer_history() from public;
alter table platform.cleanup_writer_epoch enable row level security;
alter table platform.cleanup_writer_scopes enable row level security;
alter table platform.cleanup_writer_holds enable row level security;
alter table platform.cleanup_writer_deliveries enable row level security;
alter table platform.cleanup_owner_grants enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.cleanup_writer_epoch,platform.cleanup_writer_scopes,platform.cleanup_writer_holds,platform.cleanup_writer_deliveries,platform.cleanup_owner_grants from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.cleanup_writer_epoch,platform.cleanup_writer_scopes,platform.cleanup_writer_holds,platform.cleanup_writer_deliveries,platform.cleanup_owner_grants from service_role;
    grant select on table platform.cleanup_writer_epoch to service_role;
    grant execute on function platform.cleanup_scope_epoch_unknown(text,text,text) to service_role;
    grant select,insert on table platform.cleanup_writer_scopes,platform.cleanup_writer_holds,platform.cleanup_writer_deliveries,platform.cleanup_owner_grants to service_role;
    -- Row locking needs UPDATE privilege; the immutable trigger refuses actual UPDATE.
    grant update on table platform.cleanup_writer_scopes to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (15, 'cleanup_writer_barriers', '1630821507e71c2ec68d0918bd82b0333aabb4f4211654927cc07d7eb4a6c123')
on conflict (version) do nothing;

-- ============================ migration 16: cleanup_writer_settlements ============================

create table if not exists platform.standalone_plan_backends (
  target_digest text primary key check (target_digest ~ '^[a-f0-9]{64}$'),
  workspace_id text not null,
  project_id text not null,
  environment_id text not null,
  backend_digest text not null check (backend_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists standalone_plan_backends_scope on platform.standalone_plan_backends(workspace_id,project_id,environment_id);
create table if not exists platform.standalone_plan_settlements (
  workspace_id text not null,
  project_id text not null,
  environment_id text not null,
  operation_id text not null,
  attempt_id text not null,
  manifest_digest text not null check (manifest_digest ~ '^[a-f0-9]{64}$'),
  raw_sha256 text not null check (raw_sha256 ~ '^[a-f0-9]{64}$'),
  backend_digest text not null check (backend_digest ~ '^[a-f0-9]{64}$'),
  target_digest text not null check (target_digest ~ '^[a-f0-9]{64}$'),
  holder text not null,
  fence_token bigint not null,
  settlement_digest text not null check (settlement_digest ~ '^[a-f0-9]{64}$'),
  iv text not null check (length(iv)=16),
  auth_tag text not null check (length(auth_tag)=24),
  ciphertext text not null check (length(ciphertext) between 1 and 16384),
  created_at timestamptz not null default clock_timestamp(),
  primary key(workspace_id,operation_id,attempt_id),
  foreign key(workspace_id,operation_id) references platform.operations(workspace_id,id),
  foreign key(target_digest) references platform.standalone_plan_backends(target_digest)
);
create index if not exists standalone_plan_settlements_scope on platform.standalone_plan_settlements(workspace_id,project_id,environment_id);
drop trigger if exists immutable_standalone_plan_backend on platform.standalone_plan_backends;
create trigger immutable_standalone_plan_backend before update or delete on platform.standalone_plan_backends
for each row execute function platform.immutable_cleanup_writer_history();
drop trigger if exists immutable_standalone_plan_settlement on platform.standalone_plan_settlements;
create trigger immutable_standalone_plan_settlement before update or delete on platform.standalone_plan_settlements
for each row execute function platform.immutable_cleanup_writer_history();
alter table platform.standalone_plan_backends enable row level security;
alter table platform.standalone_plan_settlements enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.standalone_plan_backends,platform.standalone_plan_settlements from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.standalone_plan_backends,platform.standalone_plan_settlements from service_role;
    grant select,insert on table platform.standalone_plan_backends,platform.standalone_plan_settlements to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (16, 'cleanup_writer_settlements', '30f73b35ae4bf2da289bd1a3ce403cc0bd409f383efb942a7aa095235333d711')
on conflict (version) do nothing;

-- ============================ migration 17: machine_runbooks ============================

create or replace function platform.immutable_runbook_rows() returns trigger language plpgsql as $$
begin
  raise exception 'Runbook versions, approvals and audit entries cannot be changed or removed' using errcode='23514';
end
$$;

create table if not exists platform.machine_runbook_versions (
  workspace_id text not null,
  runbook_id text not null check (runbook_id ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  version integer not null check (version >= 1),
  name text not null,
  definition jsonb not null,
  definition_digest text not null check (definition_digest ~ '^[a-f0-9]{64}$'),
  signature text not null check (length(signature) between 1 and 4096),
  signing_kid text not null,
  published_by text not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, runbook_id, version)
);
drop trigger if exists immutable_runbook_versions on platform.machine_runbook_versions;
create trigger immutable_runbook_versions before update or delete on platform.machine_runbook_versions
for each row execute function platform.immutable_runbook_rows();

create table if not exists platform.machine_runbook_approvals (
  id text primary key,
  workspace_id text not null,
  binding_digest text not null check (binding_digest ~ '^[a-f0-9]{64}$'),
  requested_by text not null,
  approver_id text not null check (approver_id <> requested_by),
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists machine_runbook_approvals_binding on platform.machine_runbook_approvals(workspace_id, binding_digest, created_at desc);
drop trigger if exists immutable_runbook_approvals on platform.machine_runbook_approvals;
create trigger immutable_runbook_approvals before update or delete on platform.machine_runbook_approvals
for each row execute function platform.immutable_runbook_rows();

create table if not exists platform.machine_runbook_schedules (
  id text primary key,
  workspace_id text not null,
  runbook_id text not null,
  version integer not null,
  spec jsonb not null,
  targets jsonb not null,
  binding_digest text not null check (binding_digest ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('pending_approval','active','paused','cancelled','completed')),
  next_due_at timestamptz,
  created_by text not null,
  creator jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, runbook_id, version) references platform.machine_runbook_versions(workspace_id, runbook_id, version)
);
create index if not exists machine_runbook_schedules_due on platform.machine_runbook_schedules(next_due_at) where status = 'active';

create table if not exists platform.machine_runbook_runs (
  id text primary key,
  workspace_id text not null,
  runbook_id text not null,
  version integer not null,
  definition_digest text not null check (definition_digest ~ '^[a-f0-9]{64}$'),
  binding_digest text not null check (binding_digest ~ '^[a-f0-9]{64}$'),
  schedule_id text references platform.machine_runbook_schedules(id),
  due_at timestamptz,
  targets jsonb not null,
  max_parallel_targets integer not null check (max_parallel_targets between 1 and 5),
  status text not null check (status in ('pending_approval','approved','running','succeeded','failed','cancelled','expired','uncertain')),
  cancel_requested_at timestamptz,
  cancel_reason text,
  requested_by text not null,
  requester jsonb not null,
  deadline_at timestamptz not null,
  lease_until timestamptz,
  failure_code text,
  created_at timestamptz not null default clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  foreign key (workspace_id, runbook_id, version) references platform.machine_runbook_versions(workspace_id, runbook_id, version),
  check ((schedule_id is null) = (due_at is null))
);
create unique index if not exists machine_runbook_runs_slot on platform.machine_runbook_runs(schedule_id, due_at) where schedule_id is not null;
create index if not exists machine_runbook_runs_scope on platform.machine_runbook_runs(workspace_id, status, created_at desc);

create table if not exists platform.machine_runbook_run_steps (
  workspace_id text not null,
  run_id text not null references platform.machine_runbook_runs(id),
  target_index integer not null check (target_index >= 0),
  step_id text not null,
  operation_id text not null,
  status text not null check (status in ('started','succeeded','failed','uncertain','skipped')),
  error_code text,
  evidence_id text,
  started_at timestamptz not null,
  finished_at timestamptz,
  primary key (workspace_id, run_id, target_index, step_id)
);

create table if not exists platform.machine_runbook_audit (
  workspace_id text not null,
  subject text not null,
  seq integer not null check (seq >= 1),
  event text not null,
  actor text not null,
  detail jsonb not null,
  prev_digest text not null check (prev_digest ~ '^[a-f0-9]{64}$'),
  entry_digest text not null check (entry_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null,
  primary key (workspace_id, subject, seq)
);
drop trigger if exists immutable_runbook_audit on platform.machine_runbook_audit;
create trigger immutable_runbook_audit before update or delete on platform.machine_runbook_audit
for each row execute function platform.immutable_runbook_rows();

alter table platform.machine_runbook_versions enable row level security;
alter table platform.machine_runbook_approvals enable row level security;
alter table platform.machine_runbook_schedules enable row level security;
alter table platform.machine_runbook_runs enable row level security;
alter table platform.machine_runbook_run_steps enable row level security;
alter table platform.machine_runbook_audit enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.machine_runbook_versions,platform.machine_runbook_approvals,platform.machine_runbook_schedules,platform.machine_runbook_runs,platform.machine_runbook_run_steps,platform.machine_runbook_audit from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.machine_runbook_versions,platform.machine_runbook_approvals,platform.machine_runbook_schedules,platform.machine_runbook_runs,platform.machine_runbook_run_steps,platform.machine_runbook_audit from service_role;
    grant select,insert on table platform.machine_runbook_versions,platform.machine_runbook_approvals,platform.machine_runbook_audit to service_role;
    grant select,insert,update on table platform.machine_runbook_schedules,platform.machine_runbook_runs,platform.machine_runbook_run_steps to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (17, 'machine_runbooks', '757f57cf9d043b3f7bb2dcaa9af025c0a3251596a1ed5ddf9e6c21c6009518b9')
on conflict (version) do nothing;

-- ============================ migration 18: ownership_transfers ============================

create table if not exists platform.ownership_transfers (
  id               text        not null primary key,
  workspace_id     text        not null,
  project_id       text,
  environment_id   text        not null,
  address          text        not null check (length(address) between 1 and 500),
  resource_type    text        not null check (length(resource_type) between 1 and 200),
  field_path       text        not null check (length(field_path) between 1 and 500),
  from_owner       text        not null check (from_owner in ('iac','native-op','autoscaler')),
  to_owner         text        not null check (to_owner in ('iac','native-op','autoscaler') and to_owner <> from_owner),
  transfer_digest  text        not null check (transfer_digest ~ '^[0-9a-f]{64}$'),
  operation_id     text        not null,
  approval_id      text        not null references platform.approvals(id),
  proposal_digest  text        not null check (proposal_digest ~ '^[0-9a-f]{64}$'),
  approved_at      timestamptz not null,
  expires_at       timestamptz,
  created_at       timestamptz not null default clock_timestamp(),
  revoked_at       timestamptz,
  revoked_by       text,
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id),
  unique (workspace_id, operation_id, transfer_digest),
  check ((revoked_at is null) = (revoked_by is null))
);
create index if not exists ownership_transfers_env_address on platform.ownership_transfers (workspace_id, environment_id, address) where revoked_at is null;
create or replace function platform.ownership_transfer_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Ownership transfers cannot be deleted' using errcode = '23514';
  end if;
  if old.revoked_at is not null
     or new.revoked_at is null
     or (new.id, new.workspace_id, new.project_id, new.environment_id, new.address, new.resource_type, new.field_path, new.from_owner,
         new.to_owner, new.transfer_digest, new.operation_id, new.approval_id, new.proposal_digest, new.approved_at, new.expires_at, new.created_at)
        is distinct from
        (old.id, old.workspace_id, old.project_id, old.environment_id, old.address, old.resource_type, old.field_path, old.from_owner,
         old.to_owner, old.transfer_digest, old.operation_id, old.approval_id, old.proposal_digest, old.approved_at, old.expires_at, old.created_at)
  then
    raise exception 'Ownership transfers can only be revoked, once' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists ownership_transfer_guard on platform.ownership_transfers;
create trigger ownership_transfer_guard before update or delete on platform.ownership_transfers
for each row execute function platform.ownership_transfer_guard();
alter table platform.ownership_transfers enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.ownership_transfers from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.ownership_transfers from service_role;
    grant select,insert on table platform.ownership_transfers to service_role;
    grant update (revoked_at, revoked_by) on table platform.ownership_transfers to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (18, 'ownership_transfers', 'd19177da5b80a5bde2ea6b51d232f288d7123546d7aca483d216d710bd769e7a')
on conflict (version) do nothing;

-- ============================ migration 19: incident_stability ============================

alter table platform.incidents add column if not exists fingerprint text;
alter table platform.incidents add column if not exists occurrence_count integer not null default 1;
alter table platform.incidents add column if not exists last_seen_at timestamptz;
alter table platform.incidents add column if not exists escalated_at timestamptz;
alter table platform.incidents add column if not exists escalation_reasons jsonb not null default '[]'::jsonb;
alter table platform.incidents add column if not exists escalation_acknowledged_at timestamptz;
alter table platform.incidents add column if not exists escalation_acknowledged_by text;
create unique index if not exists incidents_open_fingerprint
  on platform.incidents (workspace_id, fingerprint)
  where fingerprint is not null and status <> 'resolved';

create table if not exists platform.incident_signal_state (
  workspace_id        text        not null,
  environment_id      text        not null,
  fingerprint         text        not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  state               text        not null default 'quiet' check (state in ('quiet','active')),
  consecutive_bad     integer     not null default 0 check (consecutive_bad >= 0),
  consecutive_good    integer     not null default 0 check (consecutive_good >= 0),
  last_observed_at    timestamptz not null,
  cooldown_until      timestamptz,
  updated_at          timestamptz not null default clock_timestamp(),
  primary key (workspace_id, environment_id, fingerprint)
);

create table if not exists platform.incident_remediation_attempts (
  id               text        not null primary key,
  workspace_id     text        not null,
  incident_id      text        not null,
  environment_id   text        not null,
  fingerprint      text        not null,
  idempotency_key  text        not null check (idempotency_key ~ '^[a-f0-9]{64}$'),
  capability       text        not null,
  resource_id      text,
  blast_radius     text        not null check (blast_radius in ('low','medium','high')),
  status           text        not null check (status in ('reserved','succeeded','failed','abandoned','blocked')),
  block_codes      jsonb       not null default '[]'::jsonb,
  operation_id     text,
  reserved_at      timestamptz not null default clock_timestamp(),
  settled_at       timestamptz,
  unique (workspace_id, id),
  foreign key (workspace_id, incident_id) references platform.incidents (workspace_id, id)
);
create unique index if not exists incident_attempts_key_live
  on platform.incident_remediation_attempts (workspace_id, incident_id, idempotency_key) where status <> 'blocked';
create index if not exists incident_attempts_incident on platform.incident_remediation_attempts (workspace_id, incident_id, reserved_at);
create index if not exists incident_attempts_env on platform.incident_remediation_attempts (workspace_id, environment_id, reserved_at);
create unique index if not exists incident_attempts_operation
  on platform.incident_remediation_attempts (workspace_id, operation_id) where operation_id is not null and status <> 'blocked';
create index if not exists incident_attempts_fp on platform.incident_remediation_attempts (workspace_id, fingerprint, reserved_at);

create table if not exists platform.incident_maintenance_windows (
  id              text        not null primary key,
  workspace_id    text        not null,
  environment_id  text,
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  reason          text        not null,
  created_by      text        not null,
  cancelled_at    timestamptz,
  created_at      timestamptz not null default clock_timestamp(),
  unique (workspace_id, id),
  check (ends_at > starts_at),
  check (ends_at - starts_at <= interval '7 days')
);
create index if not exists incident_windows_ws on platform.incident_maintenance_windows (workspace_id, ends_at desc);

create table if not exists platform.incident_postmortems (
  id             text        not null primary key,
  workspace_id   text        not null,
  incident_id    text        not null,
  document       jsonb       not null,
  document_digest text       not null check (document_digest ~ '^[a-f0-9]{64}$'),
  created_at     timestamptz not null default clock_timestamp(),
  unique (workspace_id, incident_id),
  foreign key (workspace_id, incident_id) references platform.incidents (workspace_id, id)
);

insert into platform.schema_migrations (version, name, checksum)
values (19, 'incident_stability', '1db1a588796af8f7c9c01f62ab96e43d8f56a0f7e98b436a68af7e22813f8340')
on conflict (version) do nothing;

-- ============================ migration 20: optimizer_settings ============================

create table if not exists platform.optimizer_settings (
  environment_id text primary key,
  workspace_id   text not null,
  enabled        boolean not null default false,
  version        integer not null default 1 check (version >= 1),
  updated_by     text not null,
  updated_at     timestamptz not null default clock_timestamp()
);
create index if not exists optimizer_settings_enabled on platform.optimizer_settings(workspace_id, environment_id) where enabled;
alter table platform.optimizer_settings enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.optimizer_settings from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.optimizer_settings from service_role;
    grant select,insert,update on table platform.optimizer_settings to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (20, 'optimizer_settings', '94217cb0c092fa1c268ba54b3fe10143382531dd74d9081c190030f26b67b249')
on conflict (version) do nothing;

-- ============================ migration 21: scheduled_job_runs ============================

create table if not exists platform.scheduled_job_runs (
  job                  text primary key check (job ~ '^[a-z][a-z0-9-]{0,63}$'),
  cadence_ms           integer not null check (cadence_ms between 1000 and 86400000),
  last_source          text not null check (last_source in ('temporal','fallback')),
  last_status          text not null check (last_status in ('running','ok','failed','skipped')),
  last_started_at      timestamptz not null default clock_timestamp(),
  last_finished_at     timestamptz,
  last_success_at      timestamptz,
  last_success_source  text check (last_success_source in ('temporal','fallback')),
  last_error_code      text check (last_error_code is null or last_error_code ~ '^[a-z_]{1,64}$'),
  last_fence           bigint not null default 0,
  last_counts          jsonb not null default '{}'::jsonb,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  runs_total           bigint not null default 0,
  missed_ticks_total   bigint not null default 0,
  skipped_total        bigint not null default 0,
  updated_at           timestamptz not null default clock_timestamp()
);
alter table platform.scheduled_job_runs enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.scheduled_job_runs from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.scheduled_job_runs from service_role;
    grant select,insert,update on table platform.scheduled_job_runs to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (21, 'scheduled_job_runs', '462b8688f2776cf278dc0376c4f161c7169a3bc34ee77f6ad066006502108ab4')
on conflict (version) do nothing;

-- ============================ migration 22: connection_rotations ============================

create table if not exists platform.connection_rotations (
  id                  text        not null primary key,
  workspace_id        text        not null,
  connection_id       text        not null,
  status              text        not null check (status in ('staged','verified','failed','promoted','aborted','superseded')),
  base_config_digest  text        not null check (base_config_digest ~ '^[0-9a-f]{64}$'),
  candidate_config    jsonb       not null,
  candidate_digest    text        not null check (candidate_digest ~ '^[0-9a-f]{64}$'),
  verification_detail text,
  verified_at         timestamptz,
  created_by          text        not null,
  created_at          timestamptz not null default clock_timestamp(),
  resolved_by         text,
  resolved_at         timestamptz,
  foreign key (workspace_id, connection_id) references platform.provider_connections (workspace_id, id),
  check ((status in ('promoted','aborted','superseded')) = (resolved_at is not null))
);
create unique index if not exists connection_rotations_open on platform.connection_rotations (workspace_id, connection_id) where status in ('staged','verified','failed');
create index if not exists connection_rotations_ws on platform.connection_rotations (workspace_id, connection_id, created_at desc);
alter table platform.connection_rotations enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.connection_rotations from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.connection_rotations from service_role;
    grant select,insert,update on table platform.connection_rotations to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (22, 'connection_rotations', 'a2048eb9416e3207b9a6a4b863a2458dc2667ef9c64b2903c306ffaefa2df79b')
on conflict (version) do nothing;

-- ============================ migration 23: release_pipelines ============================

create table if not exists platform.release_runs (
  id               text        not null primary key,
  workspace_id     text        not null,
  project_id       text,
  environment_id   text        not null,
  operation_id     text        not null,
  revision_id      text,
  requested_by     text        not null,
  service_address  text        not null check (length(service_address) between 1 and 500),
  kind             text        not null check (kind in ('deploy','rollback')),
  state            text        not null check (state in ('planned','built','verified','blocked_approval','deployed','migrated','ready','cut_over','readback_verified','cut_over_unverified','failed','uncertain','rolled_back','refused')),
  image_uri        text        not null check (length(image_uri) between 1 and 500),
  image_digest     text        not null check (image_digest ~ '^sha256:[0-9a-f]{64}$'),
  source_digest    text,
  previous_digest  text        check (previous_digest is null or previous_digest ~ '^sha256:[0-9a-f]{64}$'),
  restores_run_id  text,
  provenance       jsonb       not null,
  migration        jsonb       not null,
  rollout          jsonb       not null,
  readback         jsonb,
  reason           text        check (reason is null or length(reason) <= 600),
  version          integer     not null default 1 check (version >= 1),
  created_at       timestamptz not null default clock_timestamp(),
  updated_at       timestamptz not null default clock_timestamp(),
  unique (workspace_id, operation_id, service_address, kind),
  unique (workspace_id, id)
);
create index if not exists release_runs_env_service on platform.release_runs (workspace_id, environment_id, service_address, created_at desc);
create index if not exists release_runs_revision on platform.release_runs (workspace_id, environment_id, service_address, revision_id) where revision_id is not null;
create index if not exists release_runs_digest on platform.release_runs (workspace_id, environment_id, service_address, image_digest);

create table if not exists platform.release_events (
  workspace_id text        not null,
  run_id       text        not null,
  seq          integer     not null check (seq >= 1),
  from_state   text,
  to_state     text        not null,
  detail       text        not null check (length(detail) <= 600),
  actor        text        not null check (length(actor) <= 200),
  created_at   timestamptz not null default clock_timestamp(),
  primary key (workspace_id, run_id, seq),
  foreign key (workspace_id, run_id) references platform.release_runs (workspace_id, id)
);

create table if not exists platform.release_migration_approvals (
  id              text        not null primary key,
  workspace_id    text        not null,
  run_id          text        not null,
  binding_digest  text        not null check (binding_digest ~ '^[0-9a-f]{64}$'),
  class           text        not null check (class in ('data','contract','unclassified')),
  approved_by     text        not null,
  requested_by    text        not null,
  approved_at     timestamptz not null,
  expires_at      timestamptz not null,
  consumed_at     timestamptz,
  foreign key (workspace_id, run_id) references platform.release_runs (workspace_id, id),
  unique (workspace_id, run_id, binding_digest),
  check (approved_by <> requested_by),
  check (expires_at > approved_at)
);
create index if not exists release_migration_approvals_binding on platform.release_migration_approvals (workspace_id, binding_digest, approved_at desc);

create or replace function platform.release_run_guard() returns trigger language plpgsql as $$
declare allowed text[];
begin
  if tg_op = 'DELETE' then
    raise exception 'Release runs cannot be deleted' using errcode = '23514';
  end if;
  if (new.id, new.workspace_id, new.project_id, new.environment_id, new.operation_id, new.revision_id, new.requested_by, new.service_address, new.kind,
      new.image_digest, new.source_digest, new.created_at)
     is distinct from
     (old.id, old.workspace_id, old.project_id, old.environment_id, old.operation_id, old.revision_id, old.requested_by, old.service_address, old.kind,
      old.image_digest, old.source_digest, old.created_at) then
    raise exception 'A release is bound to its image digest and identity; they cannot change' using errcode = '23514';
  end if;
  if new.version <> old.version + 1 then
    raise exception 'Release version must advance by one' using errcode = '23514';
  end if;
  allowed := case old.state
    when 'planned' then array['built','failed','uncertain','refused']
    when 'built' then array['verified','failed','uncertain','refused']
    when 'verified' then array['verified','blocked_approval','deployed','failed','uncertain','refused']
    when 'blocked_approval' then array['blocked_approval','verified','failed','uncertain','refused']
    when 'deployed' then array['deployed','migrated','rolled_back','failed','uncertain','refused']
    when 'migrated' then array['ready','rolled_back','failed','uncertain','refused']
    when 'ready' then array['cut_over','rolled_back','failed','uncertain','refused']
    when 'cut_over' then array['readback_verified','cut_over_unverified','rolled_back','failed','uncertain','refused']
    when 'readback_verified' then array['rolled_back']
    when 'cut_over_unverified' then array['rolled_back']
    when 'uncertain' then array['rolled_back','failed']
    else array[]::text[]
  end;
  if not (new.state = any(allowed)) then
    raise exception 'A release cannot move from % to %', old.state, new.state using errcode = '23514';
  end if;
  if new.state in ('deployed','migrated','ready','cut_over','readback_verified','cut_over_unverified')
     and (new.provenance->>'level' is null or new.provenance->>'level' = 'none') then
    raise exception 'A release cannot be deployed without verified provenance' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists release_run_guard on platform.release_runs;
create trigger release_run_guard before update or delete on platform.release_runs
for each row execute function platform.release_run_guard();

create or replace function platform.release_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'Release events are append-only' using errcode = '23514';
end
$$;
drop trigger if exists release_events_append_only on platform.release_events;
create trigger release_events_append_only before update or delete on platform.release_events
for each row execute function platform.release_append_only();

create or replace function platform.release_approval_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Migration approvals cannot be deleted' using errcode = '23514';
  end if;
  if old.consumed_at is not null
     or new.consumed_at is null
     or (new.id, new.workspace_id, new.run_id, new.binding_digest, new.class, new.approved_by, new.requested_by, new.approved_at, new.expires_at)
        is distinct from
        (old.id, old.workspace_id, old.run_id, old.binding_digest, old.class, old.approved_by, old.requested_by, old.approved_at, old.expires_at) then
    raise exception 'A migration approval can only be consumed, once' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists release_approval_guard on platform.release_migration_approvals;
create trigger release_approval_guard before update or delete on platform.release_migration_approvals
for each row execute function platform.release_approval_guard();

alter table platform.release_runs enable row level security;
alter table platform.release_events enable row level security;
alter table platform.release_migration_approvals enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.release_runs,platform.release_events,platform.release_migration_approvals from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.release_runs,platform.release_events,platform.release_migration_approvals from service_role;
    grant select,insert,update on table platform.release_runs to service_role;
    grant select,insert on table platform.release_events to service_role;
    grant select,insert on table platform.release_migration_approvals to service_role;
    grant update (consumed_at) on table platform.release_migration_approvals to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (23, 'release_pipelines', '6b29a1332678cf2d72942d72994d9a4faf34e5c8cb633cb09307a17daf0fb1f6')
on conflict (version) do nothing;

-- ============================ migration 24: portability ============================

create table if not exists platform.portability_exports (
  id                text        not null primary key,
  workspace_id      text        not null,
  project_id        text,
  environment_id    text        not null,
  operation_id      text        not null,
  resource_id       text        not null,
  address           text        not null check (length(address) between 1 and 500),
  kind              text        not null check (kind in ('postgres','mysql','object_store')),
  provider          text        not null check (length(provider) between 1 and 60),
  engine            text        not null check (length(engine) between 1 and 60),
  engine_version    text        check (engine_version is null or length(engine_version) <= 200),
  destination_label text        not null check (length(destination_label) between 1 and 300),
  artifact_prefix   text        not null check (length(artifact_prefix) between 1 and 500),
  manifest_digest   text        not null check (manifest_digest ~ '^[0-9a-f]{64}$'),
  content_digest    text        not null check (content_digest ~ '^[0-9a-f]{64}$'),
  file_count        integer     not null check (file_count >= 0),
  byte_size         bigint      not null check (byte_size >= 0),
  coverage          jsonb       not null default '{}'::jsonb,
  verified_at       timestamptz not null,
  created_at        timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id),
  unique (workspace_id, operation_id),
  unique (workspace_id, id)
);
create index if not exists portability_exports_env on platform.portability_exports (workspace_id, environment_id, created_at desc);

create table if not exists platform.portability_restores (
  id                      text        not null primary key,
  workspace_id            text        not null,
  project_id              text,
  environment_id          text        not null,
  operation_id            text        not null,
  export_id               text        not null,
  target_resource_id      text        not null,
  target_address          text        not null check (length(target_address) between 1 and 500),
  kind                    text        not null check (kind in ('postgres','mysql','object_store')),
  provider                text        not null check (length(provider) between 1 and 60),
  status                  text        not null check (status in ('verified','mismatch')),
  expected_content_digest text        not null check (expected_content_digest ~ '^[0-9a-f]{64}$'),
  observed_content_digest text        not null check (observed_content_digest ~ '^[0-9a-f]{64}$'),
  readback                jsonb       not null default '{}'::jsonb,
  restored                jsonb       not null default '{}'::jsonb,
  verified_at             timestamptz not null,
  created_at              timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id),
  foreign key (workspace_id, export_id) references platform.portability_exports (workspace_id, id),
  unique (workspace_id, operation_id),
  check ((status = 'verified') = (expected_content_digest = observed_content_digest))
);
create index if not exists portability_restores_env on platform.portability_restores (workspace_id, environment_id, created_at desc);

create table if not exists platform.resource_adoptions (
  id                   text        not null primary key,
  workspace_id         text        not null,
  project_id           text,
  environment_id       text        not null,
  resource_id          text        not null,
  address              text        not null check (length(address) between 1 and 500),
  provider             text        not null check (length(provider) between 1 and 60),
  native_type          text        not null check (length(native_type) between 1 and 200),
  external_id          text        not null check (length(external_id) between 1 and 500),
  lifecycle            text        not null check (lifecycle in ('manage','manage_and_destroy')),
  claim                jsonb       not null,
  claim_digest         text        not null check (claim_digest ~ '^[0-9a-f]{64}$'),
  field_owners         jsonb       not null default '[]'::jsonb,
  baseline             jsonb       not null,
  baseline_digest      text        not null check (baseline_digest ~ '^[0-9a-f]{64}$'),
  operation_id         text        not null,
  approval_id          text        not null references platform.approvals(id),
  proposal_digest      text        not null check (proposal_digest ~ '^[0-9a-f]{64}$'),
  status               text        not null default 'active' check (status in ('active','released')),
  adopted_at           timestamptz not null default clock_timestamp(),
  released_at          timestamptz,
  released_by          text,
  release_operation_id text,
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id),
  unique (workspace_id, operation_id),
  check ((status = 'active') = (released_at is null)),
  check ((released_at is null) = (released_by is null))
);
create unique index if not exists resource_adoptions_active_object on platform.resource_adoptions (workspace_id, provider, native_type, external_id) where status = 'active';
create unique index if not exists resource_adoptions_active_address on platform.resource_adoptions (workspace_id, environment_id, address) where status = 'active';
create index if not exists resource_adoptions_env on platform.resource_adoptions (workspace_id, environment_id, adopted_at desc);

create or replace function platform.portability_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'Portability records are append-only' using errcode = '23514';
end
$$;
drop trigger if exists portability_exports_immutable on platform.portability_exports;
create trigger portability_exports_immutable before update or delete on platform.portability_exports
for each row execute function platform.portability_immutable();
drop trigger if exists portability_restores_immutable on platform.portability_restores;
create trigger portability_restores_immutable before update or delete on platform.portability_restores
for each row execute function platform.portability_immutable();

create or replace function platform.resource_adoption_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Adoption claims cannot be deleted' using errcode = '23514';
  end if;
  if old.status <> 'active'
     or new.status <> 'released'
     or new.released_at is null
     or (new.id, new.workspace_id, new.project_id, new.environment_id, new.resource_id, new.address, new.provider, new.native_type, new.external_id, new.lifecycle,
         new.claim, new.claim_digest, new.field_owners, new.baseline, new.baseline_digest, new.operation_id, new.approval_id, new.proposal_digest, new.adopted_at)
        is distinct from
        (old.id, old.workspace_id, old.project_id, old.environment_id, old.resource_id, old.address, old.provider, old.native_type, old.external_id, old.lifecycle,
         old.claim, old.claim_digest, old.field_owners, old.baseline, old.baseline_digest, old.operation_id, old.approval_id, old.proposal_digest, old.adopted_at)
  then
    raise exception 'Adoption claims can only be released, once' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists resource_adoption_guard on platform.resource_adoptions;
create trigger resource_adoption_guard before update or delete on platform.resource_adoptions
for each row execute function platform.resource_adoption_guard();

alter table platform.portability_exports enable row level security;
alter table platform.portability_restores enable row level security;
alter table platform.resource_adoptions enable row level security;
do $$
declare r text; t text;
begin
  foreach t in array array['portability_exports','portability_restores','resource_adoptions'] loop
    foreach r in array array['anon','authenticated'] loop
      if exists(select 1 from pg_roles where rolname=r) then
        execute format('revoke all on table platform.%I from %I', t, r);
      end if;
    end loop;
    if exists(select 1 from pg_roles where rolname='service_role') then
      execute format('revoke all on table platform.%I from service_role', t);
      execute format('grant select,insert on table platform.%I to service_role', t);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant update (status, released_at, released_by, release_operation_id) on table platform.resource_adoptions to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (24, 'portability', '9ae6f39475d3abb1317d44544ec0c8d6920e74f19c0b5af813339a5b41b11f20')
on conflict (version) do nothing;

-- ============================ migration 25: agent_lifecycle ============================

alter table platform.runners
  add column if not exists lifecycle jsonb not null default '{}'::jsonb,
  add column if not exists lifecycle_reported_at timestamptz;
alter table platform.machines
  add column if not exists lifecycle jsonb not null default '{}'::jsonb,
  add column if not exists lifecycle_reported_at timestamptz;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'runners_lifecycle_bounded') then
    alter table platform.runners add constraint runners_lifecycle_bounded
      check (jsonb_typeof(lifecycle) = 'object' and pg_column_size(lifecycle) <= 8192);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'machines_lifecycle_bounded') then
    alter table platform.machines add constraint machines_lifecycle_bounded
      check (jsonb_typeof(lifecycle) = 'object' and pg_column_size(lifecycle) <= 8192);
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (25, 'agent_lifecycle', '372c684b5da9f326f8852a3de713914a16b1a1849cb332967a6fb422f78e2fdd')
on conflict (version) do nothing;

-- ============================ migration 26: plugin_boundaries ============================

create table if not exists platform.plugin_registrations (
  id              text primary key,
  workspace_id    text not null,
  plugin_id       text not null,
  plugin_version  text not null,
  manifest_digest text not null check (manifest_digest ~ '^[0-9a-f]{64}$'),
  artifact_digest text not null check (artifact_digest ~ '^[0-9a-f]{64}$'),
  publisher_id    text not null,
  manifest        jsonb not null,
  provenance      jsonb not null,
  status          text not null check (status in ('pending_review','approved','rejected','revoked')),
  approved_tools  jsonb not null default '[]'::jsonb,
  approved_scopes jsonb not null default '[]'::jsonb,
  requested_by    text not null,
  reviewed_by     text,
  reviewed_at     timestamptz,
  revoked_by      text,
  revoked_at      timestamptz,
  revoke_reason   text,
  created_at      timestamptz not null default clock_timestamp(),
  unique (workspace_id, plugin_id, plugin_version)
);
create index if not exists plugin_registrations_ws on platform.plugin_registrations(workspace_id, created_at desc);
create table if not exists platform.plugin_grants (
  id              text primary key,
  workspace_id    text not null,
  registration_id text not null references platform.plugin_registrations(id),
  token_hash      text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  audience        text not null,
  credential_id   text not null,
  subject         text not null,
  scopes          jsonb not null,
  project_ids     jsonb not null,
  environment_ids jsonb,
  created_by      text not null,
  created_at      timestamptz not null default clock_timestamp(),
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  last_used_at    timestamptz
);
create index if not exists plugin_grants_registration on platform.plugin_grants(workspace_id, registration_id);
create table if not exists platform.plugin_events (
  id              text primary key,
  workspace_id    text not null,
  registration_id text not null,
  kind            text not null,
  actor           text not null,
  detail          jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default clock_timestamp()
);
create index if not exists plugin_events_registration on platform.plugin_events(workspace_id, registration_id, created_at);
alter table platform.plugin_registrations enable row level security;
alter table platform.plugin_grants enable row level security;
alter table platform.plugin_events enable row level security;
do $$
declare r text; t text;
begin
  foreach t in array array['plugin_registrations','plugin_grants','plugin_events'] loop
    foreach r in array array['anon','authenticated'] loop
      if exists(select 1 from pg_roles where rolname=r) then
        execute format('revoke all on table platform.%I from %I',t,r);
      end if;
    end loop;
    if exists(select 1 from pg_roles where rolname='service_role') then
      execute format('revoke all on table platform.%I from service_role',t);
      if t = 'plugin_events' then
        execute format('grant select,insert on table platform.%I to service_role',t);
      else
        execute format('grant select,insert,update on table platform.%I to service_role',t);
      end if;
    end if;
  end loop;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (26, 'plugin_boundaries', '730dd0df2e58ff3f1e255ade7651cfac75879d84752f620d2785dff359c98c3a')
on conflict (version) do nothing;

-- ============================ migration 27: github_revocation_reason ============================

alter table platform.github_source_bindings add column if not exists revoked_reason text
  check (revoked_reason is null or revoked_reason in ('user_unbind', 'installation_deleted', 'installation_suspended', 'repositories_removed'));
alter table platform.github_binding_events add column if not exists reason text
  check (reason is null or reason in ('user_unbind', 'installation_deleted', 'installation_suspended', 'repositories_removed'));

insert into platform.schema_migrations (version, name, checksum)
values (27, 'github_revocation_reason', '5af4252a6e4d0a65fe712b50b9d1da0f418ba3176c4c6f3ba0314bac7bd90b12')
on conflict (version) do nothing;

-- ============================ migration 28: incident_stability_hardening ============================

create index if not exists machine_runbook_schedules_scope
  on platform.machine_runbook_schedules(workspace_id, created_at desc);

alter table platform.incident_signal_state enable row level security;
alter table platform.incident_remediation_attempts enable row level security;
alter table platform.incident_maintenance_windows enable row level security;
alter table platform.incident_postmortems enable row level security;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table platform.incident_signal_state,platform.incident_remediation_attempts,platform.incident_maintenance_windows,platform.incident_postmortems from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table platform.incident_signal_state,platform.incident_remediation_attempts,platform.incident_maintenance_windows,platform.incident_postmortems from service_role;
    grant select,insert,update,delete on table platform.incident_signal_state,platform.incident_remediation_attempts,platform.incident_maintenance_windows,platform.incident_postmortems to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (28, 'incident_stability_hardening', '53fc08fb199fb67385b19a5bc251ca178c55026f50cb2c4a3db21ce44a5880b8')
on conflict (version) do nothing;

-- ============================ migration 29: cleanup_writer_record_fields ============================

create or replace function platform.cleanup_writer_transition() returns trigger
language plpgsql security definer set search_path=pg_catalog,platform as $$
declare
  o platform.operations%rowtype;
  h platform.cleanup_writer_holds%rowtype;
  ws text;
  opid text;
  family_name text;
  delivery_id text;
  delivery_cap text;
  delivery_attempt text;
  read_only_cap boolean;
begin
  ws:=new.workspace_id; opid:=new.operation_id;
  if TG_TABLE_NAME='workflow_start_intents' then
    if new.phase<>'attempted' or (TG_OP='UPDATE' and old.phase<>'prepared') then return new; end if;
    family_name:='workflow'; delivery_id:=opid || ':' || new.attempt_id; delivery_attempt:=new.attempt_id;
  elsif TG_TABLE_NAME='plan_artifact_uses' then
    if new.phase<>'dispatched' or (TG_OP='UPDATE' and old.phase<>'claimed') then return new; end if;
    family_name:='plan'; delivery_id:=opid || ':' || new.attempt_id; delivery_attempt:=new.attempt_id;
  elsif TG_TABLE_NAME='build_launches' then
    family_name:='build'; delivery_id:=opid || ':' || new.service_address || ':' || new.attempt_id;
  elsif TG_TABLE_NAME='runner_jobs' or TG_TABLE_NAME='machine_requests' then
    if new.status<>'running' or (TG_OP='UPDATE' and old.status='running') then return new; end if;
    family_name:=case when TG_TABLE_NAME='runner_jobs' then 'runner' else 'machine' end;
    delivery_id:=new.id; delivery_cap:=new.capability;
  elsif TG_TABLE_NAME='capability_grants' then
    family_name:='grant'; delivery_id:=new.jti; delivery_cap:=new.capability;
  else
    raise exception 'Unsupported cleanup writer' using errcode='23514';
  end if;
  if delivery_cap in ('infrastructure.plan','infrastructure.observe','topology.read','logs.read','metrics.read','traces.read',
    'events.read','incident.investigate','cost.estimate','firewall.inspect','placement.solve','machine.inspect','process.list',
    'service.status','container.list','container.inspect','container.logs','file.read','network.portCheck','network.dnsCheck','system.metrics','system.logs') then return new; end if;
  -- Every INSERT's operation FK must be acquired before the coordinator.
  -- UPDATE already owns its row and unchanged FK: do not add an op lock.
  if TG_OP='INSERT' then
    select * into o from platform.operations where workspace_id=ws and id=opid for key share;
  else
    select * into o from platform.operations where workspace_id=ws and id=opid;
  end if;
  if not found then raise exception 'Cleanup writer owner is unavailable' using errcode='23514'; end if;
  if o.workspace_id is distinct from o.proposal->'scope'->>'workspaceId'
    or o.project_id is distinct from o.proposal->'scope'->>'projectId'
    or o.environment_id is distinct from o.proposal->'scope'->>'environmentId' then
    raise exception 'Cleanup writer scope projection changed' using errcode='23514';
  end if;
  delivery_cap:=coalesce(delivery_cap,o.capability);
  read_only_cap:=delivery_cap in ('infrastructure.plan','infrastructure.observe','topology.read','logs.read','metrics.read','traces.read',
    'events.read','incident.investigate','cost.estimate','firewall.inspect','placement.solve','machine.inspect','process.list',
    'service.status','container.list','container.inspect','container.logs','file.read','network.portCheck','network.dnsCheck','system.metrics','system.logs');
  if read_only_cap and family_name<>'build' then return new; end if;
  insert into platform.cleanup_writer_scopes(workspace_id) values(ws) on conflict do nothing;
  perform workspace_id from platform.cleanup_writer_scopes where workspace_id=ws for update;
  select * into h from platform.cleanup_writer_holds where workspace_id=ws
    and (o.project_id is null or o.environment_id is null or (project_id=o.project_id and environment_id=o.environment_id)) limit 1;
  if found then
    if family_name='grant' then
      if delivery_cap='infrastructure.destroy' and new.audience='worker'
        and exists(select 1 from platform.cleanup_owner_grants g join platform.plan_artifact_uses u
          on u.workspace_id=g.workspace_id and u.operation_id=g.operation_id
          where g.workspace_id=ws and g.operation_id=opid and g.jti=new.jti and g.attempt_id=h.attempt_id and g.generation=h.generation
            and u.phase='claimed' and u.attempt_id=h.attempt_id and u.holder=h.holder and u.fence_token=h.fence_token)
        and o.id=h.operation_id and o.status='running' and o.lease_until>clock_timestamp() and o.expires_at>clock_timestamp()
        and o.lease_holder='workflow:' || o.id and o.lease_scope='env:' || h.environment_id and o.fence_token=h.fence_token
        and exists(select 1 from platform.leases l where l.workspace_id=ws and l.scope=o.lease_scope and l.holder=h.holder
          and l.fence_token=h.fence_token and l.expires_at>clock_timestamp()) then
        delivery_attempt:=h.attempt_id;
      else
        raise exception 'Cleanup hold refuses a new possible delivery' using errcode='23514';
      end if;
    elsif family_name='plan' and o.id=h.operation_id and delivery_attempt=h.attempt_id
      and exists(select 1 from platform.cleanup_owner_grants g join platform.capability_grants c on c.jti=g.jti
        where g.workspace_id=ws and g.operation_id=opid and g.attempt_id=h.attempt_id and g.generation=h.generation
          and c.workspace_id=ws and c.operation_id=opid and c.capability='infrastructure.destroy' and c.audience='worker'
          and c.revoked_at is null and c.expires_at>clock_timestamp()) then
      null;
    else
      raise exception 'Cleanup hold refuses a new possible delivery' using errcode='23514';
    end if;
  elsif delivery_cap='infrastructure.destroy' and family_name in ('grant','plan') then
    -- Direct provider teardown cannot issue a bearer before an authenticated paired hold.
    raise exception 'Destroy requires a held authenticated attempt' using errcode='23514';
  end if;
  insert into platform.cleanup_writer_deliveries(workspace_id,project_id,environment_id,operation_id,family,identity,capability,attempt_id)
    values(ws,o.project_id,o.environment_id,opid,family_name,delivery_id,delivery_cap,delivery_attempt) on conflict do nothing;
  return new;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (29, 'cleanup_writer_record_fields', 'e9cd8aaa47d4909c53f8ff5e71690cc6a07d85dae60de69d35192d97e5e7e0dc')
on conflict (version) do nothing;

-- ============================ migration 30: durable_intent_authority ============================

create table if not exists platform.operation_authority (
  workspace_id text not null,
  operation_id text not null,
  version bigint not null default 1 check (version >= 1),
  status text not null,
  approval_round integer not null default 0,
  plan_digest text,
  workflow_id text,
  fence_token bigint,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, operation_id),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id) on delete cascade
);
create or replace function platform.operation_authority_sync() returns trigger
language plpgsql security definer set search_path = pg_catalog, platform as $$
begin
  if TG_OP = 'INSERT' then
    insert into platform.operation_authority (workspace_id, operation_id, status, approval_round, plan_digest, workflow_id, fence_token)
    values (new.workspace_id, new.id, new.status, coalesce(new.approval_round, 0), new.plan_digest, new.workflow_id, new.fence_token)
    on conflict (workspace_id, operation_id) do nothing;
    return new;
  end if;
  if (new.status, new.approval_round, new.plan_digest, new.workflow_id, new.runner_job_id, new.fence_token,
      new.lease_scope, new.lease_holder, new.policy_decision_id)
     is distinct from
     (old.status, old.approval_round, old.plan_digest, old.workflow_id, old.runner_job_id, old.fence_token,
      old.lease_scope, old.lease_holder, old.policy_decision_id) then
    insert into platform.operation_authority (workspace_id, operation_id, version, status, approval_round, plan_digest, workflow_id, fence_token)
    values (new.workspace_id, new.id, 2, new.status, coalesce(new.approval_round, 0), new.plan_digest, new.workflow_id, new.fence_token)
    on conflict (workspace_id, operation_id) do update
      set version = platform.operation_authority.version + 1, status = excluded.status,
          approval_round = excluded.approval_round, plan_digest = excluded.plan_digest,
          workflow_id = excluded.workflow_id, fence_token = excluded.fence_token,
          updated_at = clock_timestamp();
  end if;
  return new;
end
$$;
drop trigger if exists operation_authority_sync on platform.operations;
create trigger operation_authority_sync after insert or update on platform.operations
for each row execute function platform.operation_authority_sync();
insert into platform.operation_authority (workspace_id, operation_id, status, approval_round, plan_digest, workflow_id, fence_token)
select workspace_id, id, status, coalesce(approval_round, 0), plan_digest, workflow_id, fence_token from platform.operations
on conflict (workspace_id, operation_id) do nothing;

create table if not exists platform.durable_intents (
  id text primary key check (id ~ '^di_[a-f0-9]{40}$'),
  workspace_id text not null,
  operation_id text not null,
  kind text not null check (kind in ('workflow_signal','workflow_start')),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  payload jsonb not null default '{}'::jsonb check (octet_length(payload::text) <= 4000),
  payload_digest text not null check (payload_digest ~ '^[a-f0-9]{64}$'),
  authority_version bigint not null check (authority_version >= 0),
  state text not null default 'pending' check (state in ('pending','delivered','dead')),
  outcome text check (outcome in ('delivered','not_found','refused','exhausted','superseded')),
  claim_epoch bigint not null default 0 check (claim_epoch >= 0),
  claimed_by text,
  lease_until timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default clock_timestamp(),
  last_error_code text check (char_length(last_error_code) <= 64),
  created_at timestamptz not null default clock_timestamp(),
  settled_at timestamptz,
  unique (workspace_id, kind, idempotency_key),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id) on delete cascade,
  check ((state = 'pending' and outcome is null and settled_at is null)
      or (state <> 'pending' and outcome is not null and settled_at is not null))
);
create index if not exists durable_intents_due on platform.durable_intents (next_attempt_at) where state = 'pending';
create index if not exists durable_intents_operation on platform.durable_intents (workspace_id, operation_id);
create or replace function platform.durable_intent_guard() returns trigger language plpgsql as $$
begin
  if (new.id, new.workspace_id, new.operation_id, new.kind, new.idempotency_key, new.payload, new.payload_digest,
      new.authority_version, new.created_at)
     is distinct from
     (old.id, old.workspace_id, old.operation_id, old.kind, old.idempotency_key, old.payload, old.payload_digest,
      old.authority_version, old.created_at) then
    raise exception 'Durable intent identity is immutable' using errcode = '23514';
  end if;
  if old.state <> 'pending' and new is distinct from old then
    raise exception 'A settled durable intent cannot change' using errcode = '23514';
  end if;
  if new.claim_epoch < old.claim_epoch or new.attempts < old.attempts then
    raise exception 'Durable intent fences only move forward' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists durable_intent_guard on platform.durable_intents;
create trigger durable_intent_guard before update on platform.durable_intents
for each row execute function platform.durable_intent_guard();

alter table platform.operation_authority enable row level security;
alter table platform.durable_intents enable row level security;
do $$
declare r text; t text;
begin
  foreach t in array array['operation_authority','durable_intents'] loop
    foreach r in array array['anon','authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on table platform.%I from %I', t, r);
      end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on table platform.%I from service_role', t);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema platform to service_role;
    -- The authority record is written only by the trigger; services read it.
    grant select on table platform.operation_authority to service_role;
    grant select, insert, update on table platform.durable_intents to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (30, 'durable_intent_authority', '56ac37869bc4d4d64e03d0fff6eb063293961c9d56a3d3a6c2537aa27edaa178')
on conflict (version) do nothing;

-- ============================ migration 31: executable_semantics ============================

create table if not exists platform.approved_semantics (
  workspace_id     text        not null,
  operation_id     text        not null,
  plan_digest      text        not null check (plan_digest ~ '^[0-9a-f]{64}$'),
  semantics_digest text        not null check (semantics_digest ~ '^[0-9a-f]{64}$'),
  semantics        jsonb       not null,
  created_at       timestamptz not null default clock_timestamp(),
  primary key (workspace_id, operation_id, plan_digest),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id),
  check (semantics->>'digest' = semantics_digest)
);

create or replace function platform.approved_semantics_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'Approved executable semantics are write-once' using errcode = '23514';
end
$$;
drop trigger if exists approved_semantics_immutable on platform.approved_semantics;
create trigger approved_semantics_immutable before update or delete on platform.approved_semantics
for each row execute function platform.approved_semantics_immutable();

create table if not exists platform.standing_grants (
  id                 text        not null primary key,
  workspace_id       text        not null,
  created_by         text        not null check (length(created_by) between 1 and 200),
  created_by_name    text        not null check (length(created_by_name) between 1 and 200),
  project_id         text,
  environment_id     text        not null,
  resource_id        text,
  capabilities       jsonb       not null check (jsonb_typeof(capabilities) = 'array' and jsonb_array_length(capabilities) between 1 and 20),
  max_risk           text        not null check (max_risk in ('low','medium','high')),
  allowed_principals jsonb       not null check (jsonb_typeof(allowed_principals) = 'array' and jsonb_array_length(allowed_principals) between 1 and 20),
  max_uses           integer     not null check (max_uses between 1 and 1000),
  uses               integer     not null default 0 check (uses >= 0),
  expires_at         timestamptz not null,
  created_at         timestamptz not null,
  status             text        not null default 'active' check (status in ('active','revoked')),
  revoked_at         timestamptz,
  revoked_by         text,
  revoked_reason     text        check (revoked_reason is null or length(revoked_reason) <= 300),
  unique (workspace_id, id),
  check (uses <= max_uses),
  check (expires_at > created_at and expires_at <= created_at + interval '30 days'),
  check ((status = 'revoked') = (revoked_at is not null))
);
create index if not exists standing_grants_env on platform.standing_grants (workspace_id, environment_id, created_at);

create table if not exists platform.standing_grant_uses (
  id            text        not null primary key,
  workspace_id  text        not null,
  grant_id      text        not null,
  operation_id  text        not null,
  principal_key text        not null check (length(principal_key) between 3 and 300),
  approval_id   text,
  created_at    timestamptz not null,
  voided_at     timestamptz,
  foreign key (workspace_id, grant_id) references platform.standing_grants (workspace_id, id),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id)
);
create unique index if not exists standing_grant_uses_once on platform.standing_grant_uses (workspace_id, grant_id, operation_id) where voided_at is null;
create index if not exists standing_grant_uses_op on platform.standing_grant_uses (workspace_id, operation_id);

create or replace function platform.standing_grant_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Standing grants cannot be deleted' using errcode = '23514';
  end if;
  if (new.id, new.workspace_id, new.created_by, new.created_by_name, new.project_id, new.environment_id, new.resource_id, new.capabilities,
      new.max_risk, new.allowed_principals, new.max_uses, new.expires_at, new.created_at)
     is distinct from
     (old.id, old.workspace_id, old.created_by, old.created_by_name, old.project_id, old.environment_id, old.resource_id, old.capabilities,
      old.max_risk, old.allowed_principals, old.max_uses, old.expires_at, old.created_at) then
    raise exception 'A standing grant keeps the scope, capabilities, principals, count and expiry it was created with' using errcode = '23514';
  end if;
  if old.status = 'revoked' and (new.status <> 'revoked' or new.revoked_at is distinct from old.revoked_at or new.revoked_by is distinct from old.revoked_by) then
    raise exception 'A revoked standing grant stays revoked' using errcode = '23514';
  end if;
  if new.uses > new.max_uses then
    raise exception 'A standing grant cannot be used more than its count' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists standing_grant_guard on platform.standing_grants;
create trigger standing_grant_guard before update or delete on platform.standing_grants
for each row execute function platform.standing_grant_guard();

create or replace function platform.standing_grant_use_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Standing grant uses cannot be deleted' using errcode = '23514';
  end if;
  if (new.id, new.workspace_id, new.grant_id, new.operation_id, new.principal_key, new.created_at)
     is distinct from
     (old.id, old.workspace_id, old.grant_id, old.operation_id, old.principal_key, old.created_at) then
    raise exception 'A standing grant use is immutable' using errcode = '23514';
  end if;
  if old.approval_id is not null and new.approval_id is distinct from old.approval_id then
    raise exception 'The approval of a standing grant use is attached once' using errcode = '23514';
  end if;
  if old.voided_at is not null and new.voided_at is distinct from old.voided_at then
    raise exception 'A voided standing grant use stays voided' using errcode = '23514';
  end if;
  if new.voided_at is not null and new.approval_id is not null then
    raise exception 'A use that produced an approval cannot be voided' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists standing_grant_use_guard on platform.standing_grant_uses;
create trigger standing_grant_use_guard before update or delete on platform.standing_grant_uses
for each row execute function platform.standing_grant_use_guard();

alter table platform.approved_semantics enable row level security;
alter table platform.standing_grants enable row level security;
alter table platform.standing_grant_uses enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.approved_semantics,platform.standing_grants,platform.standing_grant_uses from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.approved_semantics,platform.standing_grants,platform.standing_grant_uses from service_role;
    grant select,insert on table platform.approved_semantics to service_role;
    grant select,insert,update on table platform.standing_grants to service_role;
    grant select,insert,update on table platform.standing_grant_uses to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (31, 'executable_semantics', '92e4ddbca876beb8b5fb5824a3ec03d5a932e7b35bcbc8a79a341f2e2ef493ed')
on conflict (version) do nothing;

-- ============================ migration 32: plan_custody_state_recovery ============================

create table if not exists platform.plan_custody_grants (
  workspace_id text not null,
  operation_id text not null,
  worker_identity text not null check (worker_identity ~ '^[A-Za-z0-9._-]{1,64}$'),
  fence_token bigint not null,
  source_operation_id text not null,
  manifest_digest text not null check (manifest_digest ~ '^[a-f0-9]{64}$'),
  token_digest text not null check (token_digest ~ '^[a-f0-9]{64}$'),
  wrap_iv text not null check (length(wrap_iv) = 16),
  wrap_tag text not null check (length(wrap_tag) = 24),
  wrap_ciphertext text not null check (length(wrap_ciphertext) between 1 and 256),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoke_reason text check (revoke_reason is null or revoke_reason ~ '^[a-z_]{1,48}$'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, operation_id, worker_identity, fence_token),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id)
);
create index if not exists plan_custody_grants_worker on platform.plan_custody_grants (workspace_id, worker_identity);
create table if not exists platform.plan_custody_reads (
  id text primary key,
  workspace_id text not null,
  operation_id text not null,
  worker_identity text not null check (worker_identity ~ '^[A-Za-z0-9._-]{1,64}$'),
  manifest_digest text,
  outcome text not null check (outcome in ('allowed', 'refused')),
  reason text not null check (reason ~ '^[a-z_]{1,48}$'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id)
);
create index if not exists plan_custody_reads_op on platform.plan_custody_reads (workspace_id, operation_id, created_at);
create table if not exists platform.state_backend_probes (
  id text primary key,
  workspace_id text not null,
  project_id text not null,
  environment_id text not null,
  backend_digest text not null check (backend_digest ~ '^[a-f0-9]{64}$'),
  backend_kind text not null check (backend_kind in ('local', 'http', 's3', 'gcs', 'azurerm', 'pg')),
  verdict jsonb not null check (jsonb_typeof(verdict) = 'object' and pg_column_size(verdict) <= 16384),
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists state_backend_probes_env on platform.state_backend_probes (workspace_id, environment_id, created_at desc);
create table if not exists platform.state_backend_restores (
  id text primary key,
  workspace_id text not null,
  project_id text not null,
  environment_id text not null,
  backend_digest text not null check (backend_digest ~ '^[a-f0-9]{64}$'),
  backend jsonb not null check (jsonb_typeof(backend) = 'object' and pg_column_size(backend) <= 4096),
  state_key text not null check (length(state_key) between 1 and 1024),
  source_version_id text not null check (length(source_version_id) between 1 and 1024),
  source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  current_version_id text not null check (length(current_version_id) between 1 and 1024),
  connection_id text not null check (length(connection_id) between 1 and 200),
  proposal_digest text not null check (proposal_digest ~ '^[a-f0-9]{64}$'),
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected', 'executing', 'restored', 'failed_uncertain', 'expired')),
  requested_by jsonb not null,
  approved_by text,
  approved_at timestamptz,
  expires_at timestamptz not null,
  restored_version_id text,
  readback_sha256 text check (readback_sha256 is null or readback_sha256 ~ '^[a-f0-9]{64}$'),
  failure_code text check (failure_code is null or failure_code ~ '^[a-z_]{1,48}$'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, id)
);
create index if not exists state_backend_restores_env on platform.state_backend_restores (workspace_id, environment_id, created_at desc);
create or replace function platform.state_backend_restore_guard() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'State backend restore records are never deleted' using errcode = '23514';
  end if;
  if new.workspace_id <> old.workspace_id or new.environment_id <> old.environment_id or new.proposal_digest <> old.proposal_digest
    or new.backend_digest <> old.backend_digest or new.state_key <> old.state_key or new.source_version_id <> old.source_version_id
    or new.source_sha256 <> old.source_sha256 or new.current_version_id <> old.current_version_id or new.connection_id <> old.connection_id
    or new.backend::text <> old.backend::text or new.requested_by::text <> old.requested_by::text or new.expires_at <> old.expires_at then
    raise exception 'A reviewed state restore proposal is immutable' using errcode = '23514';
  end if;
  if not ((old.status = 'proposed' and new.status in ('proposed', 'approved', 'rejected', 'expired'))
    or (old.status = 'approved' and new.status in ('approved', 'executing', 'expired'))
    or (old.status = 'executing' and new.status in ('executing', 'restored', 'failed_uncertain'))
    or old.status = new.status) then
    raise exception 'Invalid state restore transition' using errcode = '23514';
  end if;
  new.updated_at := clock_timestamp();
  return new;
end
$$;
drop trigger if exists state_backend_restore_guard on platform.state_backend_restores;
create trigger state_backend_restore_guard before update or delete on platform.state_backend_restores
for each row execute function platform.state_backend_restore_guard();
drop trigger if exists immutable_plan_custody_read on platform.plan_custody_reads;
create trigger immutable_plan_custody_read before update or delete on platform.plan_custody_reads
for each row execute function platform.immutable_plan_artifact();
drop trigger if exists immutable_state_backend_probe on platform.state_backend_probes;
create trigger immutable_state_backend_probe before update or delete on platform.state_backend_probes
for each row execute function platform.immutable_plan_artifact();
alter table platform.plan_custody_grants enable row level security;
alter table platform.plan_custody_reads enable row level security;
alter table platform.state_backend_probes enable row level security;
alter table platform.state_backend_restores enable row level security;
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table platform.plan_custody_grants, platform.plan_custody_reads, platform.state_backend_probes, platform.state_backend_restores from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on table platform.plan_custody_grants, platform.plan_custody_reads, platform.state_backend_probes, platform.state_backend_restores to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (32, 'plan_custody_state_recovery', '27a0830cd2ef11dad72a582caf0c0613acc66984f22232e053194b9550babb28')
on conflict (version) do nothing;

-- ============================ migration 33: external_effects ============================

create table if not exists platform.external_effects (
  workspace_id text not null check (workspace_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  effect_id text not null check (effect_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  family text not null check (family in ('build_launch','cleanup_apply','proxy_request')),
  operation_id text not null check (operation_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  environment_id text check (environment_id is null or environment_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  provider text not null check (provider ~ '^[a-z0-9_-]{1,32}$'),
  dedup_key text not null check (dedup_key ~ '^[A-Za-z0-9_.:/=+-]{1,256}$'),
  request_digest text not null check (request_digest ~ '^[a-f0-9]{64}$'),
  target jsonb not null default '{}'::jsonb check (jsonb_typeof(target) = 'object' and octet_length(target::text) <= 8000),
  idempotency_token text check (idempotency_token is null or idempotency_token ~ '^[A-Za-z0-9_.:-]{1,256}$'),
  idempotency_supported boolean not null,
  fence_scope text check (fence_scope is null or char_length(fence_scope) <= 256),
  fence_epoch bigint check (fence_epoch is null or fence_epoch >= 0),
  state text not null default 'pending' check (state in ('pending','accepted','uncertain','conflict','confirmed','tombstoned')),
  state_reason text check (state_reason is null or char_length(state_reason) <= 500),
  provider_receipt jsonb check (provider_receipt is null or (jsonb_typeof(provider_receipt) = 'object' and octet_length(provider_receipt::text) <= 8000)),
  late_receipt jsonb check (late_receipt is null or (jsonb_typeof(late_receipt) = 'object' and octet_length(late_receipt::text) <= 8000)),
  readback jsonb check (readback is null or (jsonb_typeof(readback) = 'object' and octet_length(readback::text) <= 16000)),
  tombstone_reason text check (tombstone_reason is null or tombstone_reason in ('provider_rejected','operator_resolved_not_applied','superseded')),
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  uncertain_at timestamptz,
  primary key (workspace_id, effect_id),
  unique (workspace_id, family, dedup_key),
  foreign key (workspace_id, operation_id) references platform.operations (workspace_id, id),
  check ((state = 'tombstoned') = (tombstone_reason is not null)),
  check (state not in ('accepted','confirmed') or provider_receipt is not null or (state = 'confirmed' and readback is not null)),
  check (state not in ('uncertain') or uncertain_at is not null)
);
create index if not exists external_effects_operation on platform.external_effects (workspace_id, operation_id);
create index if not exists external_effects_open on platform.external_effects (workspace_id, state)
  where state in ('pending','accepted','uncertain','conflict');
create index if not exists external_effects_pending_sweep on platform.external_effects (updated_at)
  where state = 'pending';

create table if not exists platform.external_effect_events (
  seq bigint generated always as identity primary key,
  workspace_id text not null,
  effect_id text not null,
  kind text not null check (kind ~ '^[a-z_]{1,48}$'),
  from_state text check (from_state is null or from_state in ('pending','accepted','uncertain','conflict','confirmed','tombstoned')),
  to_state text not null check (to_state in ('pending','accepted','uncertain','conflict','confirmed','tombstoned')),
  actor text not null check (char_length(actor) between 1 and 200),
  evidence_digest text check (evidence_digest is null or evidence_digest ~ '^[a-f0-9]{64}$'),
  at timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, effect_id) references platform.external_effects (workspace_id, effect_id)
);
create index if not exists external_effect_events_effect on platform.external_effect_events (workspace_id, effect_id, seq);

create table if not exists platform.external_effect_resolutions (
  id text not null primary key check (id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  workspace_id text not null,
  effect_id text not null,
  effect_version integer not null check (effect_version >= 1),
  decision text not null check (decision in ('confirm_applied','confirm_not_applied')),
  readback_digest text not null check (readback_digest ~ '^[a-f0-9]{64}$'),
  binding_digest text not null check (binding_digest ~ '^[a-f0-9]{64}$'),
  approver_id text not null check (char_length(approver_id) between 1 and 200),
  reason text not null check (char_length(reason) between 1 and 500),
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, effect_id, effect_version),
  foreign key (workspace_id, effect_id) references platform.external_effects (workspace_id, effect_id)
);

create or replace function platform.external_effect_append_only() returns trigger language plpgsql as $$
begin
  raise exception using errcode = '23514', message = 'External effect events and resolutions cannot be changed or removed';
end $$;
drop trigger if exists external_effect_events_append_only on platform.external_effect_events;
create trigger external_effect_events_append_only before update or delete on platform.external_effect_events
  for each row execute function platform.external_effect_append_only();
drop trigger if exists external_effect_resolutions_append_only on platform.external_effect_resolutions;
create trigger external_effect_resolutions_append_only before update or delete on platform.external_effect_resolutions
  for each row execute function platform.external_effect_append_only();

-- A resolution is accepted only for an effect that is still unresolved at exactly the reviewed version, and only
-- against the readback the approver reviewed: no evidence, no resolution.
create or replace function platform.external_effect_resolution_guard() returns trigger language plpgsql as $$
declare e platform.external_effects%rowtype;
begin
  select * into e from platform.external_effects where workspace_id = new.workspace_id and effect_id = new.effect_id for share;
  if not found or e.state not in ('uncertain','conflict') or e.version <> new.effect_version
     or e.readback is null or e.readback->>'digest' is distinct from new.readback_digest
     or (new.decision = 'confirm_applied' and e.readback->>'outcome' <> 'present')
     or (new.decision = 'confirm_not_applied' and e.readback->>'outcome' <> 'absent') then
    raise exception using errcode = '23514', message = 'A resolution needs the reviewed readback of the current unresolved effect';
  end if;
  -- Absence is evidence only once the dispatching fence can no longer act (a renewed lease keeps its fence, so a
  -- live holder blocks it) and a quiet period has passed since the call could last have been in flight.
  if new.decision = 'confirm_not_applied' and (
       exists (select 1 from platform.leases l where l.scope = e.fence_scope and l.fence_token = e.fence_epoch
         and l.expires_at > clock_timestamp() and l.released_at is null)
       or e.late_receipt is not null
       or (e.readback->>'observedAt')::timestamptz < greatest(coalesce(e.uncertain_at, e.created_at), e.created_at) + interval '15 minutes') then
    raise exception using errcode = '23514', message = 'Absence cannot be accepted while the original fence is live or inside the settle window';
  end if;
  return new;
end $$;
drop trigger if exists external_effect_resolution_guard on platform.external_effect_resolutions;
create trigger external_effect_resolution_guard before insert on platform.external_effect_resolutions
  for each row execute function platform.external_effect_resolution_guard();

create or replace function platform.external_effect_guard() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception using errcode = '23514', message = 'External effects are permanent and cannot be deleted';
  end if;
  if (new.workspace_id, new.effect_id, new.family, new.operation_id, new.environment_id, new.provider, new.dedup_key,
      new.request_digest, new.target, new.idempotency_token, new.idempotency_supported, new.fence_scope, new.fence_epoch, new.created_at)
     is distinct from
     (old.workspace_id, old.effect_id, old.family, old.operation_id, old.environment_id, old.provider, old.dedup_key,
      old.request_digest, old.target, old.idempotency_token, old.idempotency_supported, old.fence_scope, old.fence_epoch, old.created_at) then
    raise exception using errcode = '23514', message = 'External effect identity is immutable';
  end if;
  if (old.provider_receipt is not null and new.provider_receipt is distinct from old.provider_receipt)
     or (old.late_receipt is not null and new.late_receipt is distinct from old.late_receipt) then
    raise exception using errcode = '23514', message = 'External effect receipts are write-once';
  end if;
  if new.version <> old.version + 1 then
    raise exception using errcode = '23514', message = 'External effect updates must advance the version by one';
  end if;
  if old.state in ('confirmed','tombstoned') then
    if new.state is distinct from old.state or new.tombstone_reason is distinct from old.tombstone_reason
       or new.provider_receipt is distinct from old.provider_receipt or new.readback is distinct from old.readback then
      raise exception using errcode = '23514', message = 'A confirmed or tombstoned effect is terminal';
    end if;
    return new;
  end if;
  if new.state is distinct from old.state then
    if old.state = 'pending' and new.state = 'accepted' and new.provider_receipt is not null then
      null;
    elsif old.state = 'pending' and new.state = 'uncertain' then
      null;
    elsif old.state = 'pending' and new.state = 'tombstoned' and new.tombstone_reason = 'provider_rejected' then
      null;
    elsif old.state = 'accepted' and new.state = 'confirmed' and new.readback->>'outcome' = 'present' and new.provider_receipt is not null then
      null;
    elsif old.state = 'accepted' and new.state in ('uncertain','conflict') then
      null;
    elsif old.state = 'uncertain' and new.state = 'conflict' then
      null;
    elsif old.state in ('uncertain','conflict') and new.state = 'confirmed' and new.readback->>'outcome' = 'present'
          and exists (select 1 from platform.external_effect_resolutions r where r.workspace_id = old.workspace_id
            and r.effect_id = old.effect_id and r.effect_version = old.version and r.decision = 'confirm_applied'
            and r.readback_digest = new.readback->>'digest') then
      null;
    elsif old.state in ('uncertain','conflict') and new.state = 'tombstoned' and new.tombstone_reason = 'operator_resolved_not_applied'
          and exists (select 1 from platform.external_effect_resolutions r where r.workspace_id = old.workspace_id
            and r.effect_id = old.effect_id and r.effect_version = old.version and r.decision = 'confirm_not_applied'
            and r.readback_digest = new.readback->>'digest') then
      null;
    else
      raise exception using errcode = '23514', message = 'Illegal external effect transition';
    end if;
  elsif old.state in ('uncertain','conflict') and new.readback is distinct from old.readback and new.readback is null then
    raise exception using errcode = '23514', message = 'Readback evidence cannot be erased';
  end if;
  return new;
end $$;
drop trigger if exists external_effect_guard on platform.external_effects;
create trigger external_effect_guard before update or delete on platform.external_effects
  for each row execute function platform.external_effect_guard();

alter table platform.external_effects enable row level security;
alter table platform.external_effect_events enable row level security;
alter table platform.external_effect_resolutions enable row level security;
do $$ declare r text; t text; begin
  foreach t in array array['external_effects','external_effect_events','external_effect_resolutions'] loop
    foreach r in array array['anon','authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on table platform.%I from %I', t, r);
      end if;
    end loop;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema platform to service_role;
    -- Creator defaults can include DELETE and TRUNCATE; the ledger admits neither.
    revoke all on table platform.external_effects from service_role;
    revoke all on table platform.external_effect_events from service_role;
    revoke all on table platform.external_effect_resolutions from service_role;
    grant select, insert, update on table platform.external_effects to service_role;
    grant select, insert on table platform.external_effect_events to service_role;
    grant select, insert on table platform.external_effect_resolutions to service_role;
  end if;
end $$;

insert into platform.schema_migrations (version, name, checksum)
values (33, 'external_effects', '39a77c75890502a0a2d9851482014522a54718520715d506f502e698c1dd76dc')
on conflict (version) do nothing;

-- ============================ migration 34: k8s_guest_bindings ============================

create table if not exists platform.k8s_guest_bindings (
  id                    text primary key,
  workspace_id          text not null,
  connection_id         text not null,
  namespace             text not null check (namespace ~ '^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$'),
  profile               text not null check (profile in ('read','exec')),
  object_name           text not null check (object_name ~ '^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$'),
  status                text not null check (status in ('provisioning','active','revoking','revoked')),
  sa_uid                text,
  issued_count          integer not null default 0 check (issued_count >= 0),
  last_issued_at        timestamptz,
  last_token_expires_at timestamptz,
  last_error            text check (last_error is null or last_error ~ '^[a-z_]{1,64}$'),
  created_at            timestamptz not null default clock_timestamp(),
  updated_at            timestamptz not null default clock_timestamp(),
  revoked_at            timestamptz,
  unique (workspace_id, connection_id, namespace, profile)
);
create index if not exists k8s_guest_bindings_connection on platform.k8s_guest_bindings(workspace_id, connection_id, status);
alter table platform.k8s_guest_bindings enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.k8s_guest_bindings from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    execute 'revoke all on table platform.k8s_guest_bindings from service_role';
    execute 'grant select,insert,update on table platform.k8s_guest_bindings to service_role';
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (34, 'k8s_guest_bindings', 'dcb43344514109a0786cd4bd161e016dd472e5c00c5f5c33d08be3479e535f26')
on conflict (version) do nothing;

-- ============================ migration 35: mcp_streams ============================

create table if not exists platform.mcp_streams (
  id                  text primary key check (id ~ '^[0-9a-f]{32}$'),
  workspace_id        text not null,
  principal_key       text not null check (principal_key ~ '^[0-9a-f]{64}$'),
  request_id          text not null check (char_length(request_id) between 1 and 200),
  protocol_version    text not null check (char_length(protocol_version) between 1 and 40),
  status              text not null check (status in ('open','completed','cancelled')),
  cancel_requested_at timestamptz,
  created_at          timestamptz not null default clock_timestamp(),
  expires_at          timestamptz not null
);
create index if not exists mcp_streams_request on platform.mcp_streams(workspace_id, principal_key, request_id, created_at desc);
create index if not exists mcp_streams_expiry on platform.mcp_streams(workspace_id, expires_at);
create table if not exists platform.mcp_stream_events (
  stream_id    text not null references platform.mcp_streams(id) on delete cascade,
  workspace_id text not null,
  seq          integer not null check (seq > 0),
  payload      jsonb not null,
  created_at   timestamptz not null default clock_timestamp(),
  primary key (stream_id, seq)
);
alter table platform.mcp_streams enable row level security;
alter table platform.mcp_stream_events enable row level security;
do $$
declare r text; t text;
begin
  foreach t in array array['mcp_streams','mcp_stream_events'] loop
    foreach r in array array['anon','authenticated'] loop
      if exists(select 1 from pg_roles where rolname=r) then
        execute format('revoke all on table platform.%I from %I',t,r);
      end if;
    end loop;
    if exists(select 1 from pg_roles where rolname='service_role') then
      execute format('revoke all on table platform.%I from service_role',t);
      execute format('grant select,insert,update,delete on table platform.%I to service_role',t);
    end if;
  end loop;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (35, 'mcp_streams', '2ff8e9a98ba733fdd3e934a6b9e0ffed3a68311b558ba05b6c10593565aca620')
on conflict (version) do nothing;

-- ============================ migration 36: coding_agent_runs ============================

create table if not exists platform.coding_agent_runs (
  id                    text primary key,
  workspace_id          text not null,
  project_id            text,
  environment_id        text,
  created_by            text not null,
  status                text not null check (status in ('running','completed','budget_exhausted','failed','cancelled')),
  stop_reason           text,
  model                 text not null,
  task                  text not null,
  source                jsonb not null,
  limits                jsonb not null,
  usage                 jsonb not null,
  checkpoint            jsonb not null,
  result                jsonb,
  proposal_operation_id text,
  workflow_id           text not null,
  version               integer not null default 1 check (version >= 1),
  created_at            timestamptz not null default clock_timestamp(),
  updated_at            timestamptz not null default clock_timestamp(),
  check (octet_length(checkpoint::text) <= 2097152)
);
create index if not exists coding_agent_runs_ws on platform.coding_agent_runs(workspace_id, created_at desc);
alter table platform.coding_agent_runs enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.coding_agent_runs from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.coding_agent_runs from service_role;
    grant select,insert,update on table platform.coding_agent_runs to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (36, 'coding_agent_runs', '404a4d5cfeb626eb491521cbfee6cde3904463364c002aae02ed252f8b9f9d65')
on conflict (version) do nothing;

-- ============================ migration 37: actual_spend ============================

create table if not exists platform.actual_spend_snapshots (
  id              text        not null primary key,
  workspace_id    text        not null,
  project_id      text,
  environment_id  text,
  provider        text        not null check (provider in ('aws','gcp','azure','oci')),
  scope           text        not null check (length(scope) between 1 and 300),
  period_start    date        not null,
  period_end      date        not null check (period_end > period_start),
  total_usd       numeric(18,6) not null,
  finalization    text        not null check (finalization in ('provisional','final')),
  response_sha256 text        not null check (response_sha256 ~ '^[0-9a-f]{64}$'),
  snapshot        jsonb       not null check (snapshot->>'kind' = 'actual_spend'),
  retrieved_at    timestamptz not null,
  recorded_by     text        not null,
  recorded_at     timestamptz not null default clock_timestamp(),
  unique (workspace_id, provider, scope, period_start, period_end, response_sha256)
);
create index if not exists actual_spend_ws_env on platform.actual_spend_snapshots (workspace_id, environment_id, period_start desc, retrieved_at desc);
alter table platform.actual_spend_snapshots enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.actual_spend_snapshots from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.actual_spend_snapshots from service_role;
    grant select,insert on table platform.actual_spend_snapshots to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (37, 'actual_spend', 'dc00e59940187d352ac3fccf2c537ae381848f47ea4048b568cfb5536079f3e9')
on conflict (version) do nothing;

-- ============================ migration 38: fair_bounded_control_plane ============================

create table if not exists platform.ops_maintenance (
  id         text primary key check (id = 'global'),
  mode       text not null check (mode in ('off','dispatch_paused','read_only')),
  reason     text not null default '' check (char_length(reason) <= 300),
  version    integer not null default 1 check (version >= 1),
  updated_by text not null check (char_length(updated_by) between 1 and 128),
  updated_at timestamptz not null default clock_timestamp()
);

create table if not exists platform.ops_maintenance_history (
  seq     bigint generated always as identity primary key,
  mode    text not null check (mode in ('off','dispatch_paused','read_only')),
  reason  text not null check (char_length(reason) <= 300),
  version integer not null check (version >= 1),
  actor   text not null check (char_length(actor) between 1 and 128),
  at      timestamptz not null default clock_timestamp()
);

create or replace function platform.ops_history_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'Maintenance history is append-only' using errcode = '23514';
end
$$;
drop trigger if exists ops_maintenance_history_immutable on platform.ops_maintenance_history;
create trigger ops_maintenance_history_immutable before update or delete on platform.ops_maintenance_history
for each row execute function platform.ops_history_immutable();

create table if not exists platform.tenant_quotas (
  workspace_id            text primary key check (char_length(workspace_id) between 1 and 128),
  weight                  integer not null default 1 check (weight between 1 and 100),
  api_rate_per_sec        numeric check (api_rate_per_sec is null or (api_rate_per_sec > 0 and api_rate_per_sec <= 100000)),
  api_burst               integer check (api_burst is null or api_burst between 1 and 100000),
  max_concurrent_requests integer check (max_concurrent_requests is null or max_concurrent_requests between 1 and 10000),
  max_active_operations   integer check (max_active_operations is null or max_active_operations between 1 and 100000),
  max_queued_jobs         integer check (max_queued_jobs is null or max_queued_jobs between 1 and 1000000),
  version                 integer not null default 1 check (version >= 1),
  updated_by              text not null check (char_length(updated_by) between 1 and 128),
  updated_at              timestamptz not null default clock_timestamp()
);

create index if not exists runner_jobs_ws_queued on platform.runner_jobs (workspace_id) where status = 'queued';

alter table platform.ops_maintenance enable row level security;
alter table platform.ops_maintenance_history enable row level security;
alter table platform.tenant_quotas enable row level security;
do $$
declare r text; t text;
begin
  foreach t in array array['ops_maintenance','ops_maintenance_history','tenant_quotas'] loop
    foreach r in array array['anon','authenticated'] loop
      if exists(select 1 from pg_roles where rolname=r) then
        execute format('revoke all on table platform.%I from %I',t,r);
      end if;
    end loop;
    if exists(select 1 from pg_roles where rolname='service_role') then
      execute format('revoke all on table platform.%I from service_role',t);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant select,insert,update on table platform.ops_maintenance to service_role;
    grant select,insert on table platform.ops_maintenance_history to service_role;
    grant select,insert,update,delete on table platform.tenant_quotas to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (38, 'fair_bounded_control_plane', 'a62e1c17ee0cc4ac8ad23361ebcd5f7d7c95e17f80e9baf2e5b139264d8dbd9e')
on conflict (version) do nothing;

-- ============================ migration 39: key_custody ============================

create table if not exists platform.key_custody_keys (
  purpose       text        not null check (purpose ~ '^(signing|enc|tls):[a-z0-9-]{1,40}$'),
  key_id        text        not null check (char_length(key_id) between 1 and 200),
  role          text        not null check (role in ('current','decrypt_only','verify_only')),
  source        text        not null check (char_length(source) between 1 and 120),
  first_seen_at timestamptz not null default clock_timestamp(),
  last_seen_at  timestamptz not null default clock_timestamp(),
  retire_after  timestamptz,
  retired_at    timestamptz,
  retired_by    text check (retired_by is null or char_length(retired_by) between 1 and 200),
  primary key (purpose, key_id),
  check (retired_at is null or role <> 'current' or retired_by is not null)
);

create table if not exists platform.key_rewrap_jobs (
  id            text        not null primary key,
  workspace_id  text        not null check (char_length(workspace_id) between 1 and 128),
  purpose       text        not null check (purpose in ('enc:vault')),
  target_key_id text        not null check (char_length(target_key_id) between 1 and 200),
  status        text        not null default 'pending' check (status in ('pending','running','completed','failed','blocked','cancelled')),
  cursor_ref    text        not null default '',
  inspected     integer     not null default 0 check (inspected >= 0),
  rewrapped     integer     not null default 0 check (rewrapped >= 0),
  unchanged     integer     not null default 0 check (unchanged >= 0),
  batches       integer     not null default 0 check (batches >= 0),
  error_code    text        check (error_code is null or error_code ~ '^[a-z_]{1,64}$'),
  requested_by  text        not null check (char_length(requested_by) between 1 and 200),
  created_at    timestamptz not null default clock_timestamp(),
  started_at    timestamptz,
  updated_at    timestamptz not null default clock_timestamp(),
  finished_at   timestamptz,
  unique (workspace_id, id),
  check ((status in ('completed','failed','blocked','cancelled')) = (finished_at is not null))
);
create unique index if not exists key_rewrap_jobs_open on platform.key_rewrap_jobs (workspace_id, purpose) where status in ('pending','running');
create index if not exists key_rewrap_jobs_queue on platform.key_rewrap_jobs (status, created_at, id) where status in ('pending','running');
create index if not exists key_rewrap_jobs_ws on platform.key_rewrap_jobs (workspace_id, created_at desc);

alter table platform.key_custody_keys enable row level security;
alter table platform.key_rewrap_jobs enable row level security;
do $$
declare r text; t text;
begin
  foreach t in array array['key_custody_keys','key_rewrap_jobs'] loop
    foreach r in array array['anon','authenticated'] loop
      if exists(select 1 from pg_roles where rolname=r) then
        execute format('revoke all on table platform.%I from %I',t,r);
      end if;
    end loop;
    if exists(select 1 from pg_roles where rolname='service_role') then
      execute format('revoke all on table platform.%I from service_role',t);
      execute format('grant select,insert,update on table platform.%I to service_role',t);
    end if;
  end loop;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (39, 'key_custody', '333eed78e5f25e4a120c255bb87690fd5ffe6727c436350dbe833498ef48bdd1')
on conflict (version) do nothing;

-- ============================ migration 40: mixed_parent_plans ============================

create table if not exists platform.mixed_parent_plans (
  workspace_id text not null check (workspace_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  plan_id text not null check (plan_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  project_id text not null check (project_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  parent_environment_id text not null check (parent_environment_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  format text not null check (format = 'zenith.mixed-parent-plan.v1'),
  graph_digest text not null check (graph_digest ~ '^[a-f0-9]{64}$'),
  manifest_digest text not null check (manifest_digest ~ '^[a-f0-9]{64}$'),
  desired_digest text not null check (desired_digest ~ '^[a-f0-9]{64}$'),
  parent_digest text not null check (parent_digest ~ '^[a-f0-9]{64}$'),
  child_set_digest text not null check (child_set_digest ~ '^[a-f0-9]{64}$'),
  plan jsonb not null check (jsonb_typeof(plan) = 'object' and octet_length(plan::text) <= 900000),
  parent_operation_id text check (parent_operation_id is null or parent_operation_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  status text not null default 'planned' check (status in ('planned','running','succeeded','failed','uncertain','cancelled')),
  created_by text not null check (char_length(created_by) between 1 and 200),
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, plan_id),
  unique (workspace_id, parent_operation_id),
  foreign key (workspace_id, parent_operation_id) references platform.operations (workspace_id, id),
  check (status = 'planned' or parent_operation_id is not null or status = 'cancelled')
);
create index if not exists mixed_parent_plans_environment on platform.mixed_parent_plans (workspace_id, parent_environment_id, created_at desc);

create table if not exists platform.mixed_child_plans (
  workspace_id text not null,
  plan_id text not null,
  partition_id text not null check (partition_id ~ '^[A-Za-z0-9_.:/-]{1,200}$'),
  ordinal integer not null check (ordinal >= 0 and ordinal < 64),
  child_environment_id text not null check (child_environment_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  connection_id text not null check (connection_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  provider text not null check (provider in ('aws','gcp','azure','oci')),
  account_id text not null check (char_length(account_id) between 1 and 300),
  region text not null check (region ~ '^[a-z0-9-]{3,40}$'),
  subplan_digest text not null check (subplan_digest ~ '^[a-f0-9]{64}$'),
  effect_digest text not null check (effect_digest ~ '^[a-f0-9]{64}$'),
  semantics_digest text not null check (semantics_digest ~ '^[a-f0-9]{64}$'),
  subplan jsonb not null check (jsonb_typeof(subplan) = 'object' and octet_length(subplan::text) <= 400000),
  child_operation_id text check (child_operation_id is null or child_operation_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  executable_semantics_digest text check (executable_semantics_digest is null or executable_semantics_digest ~ '^[a-f0-9]{64}$'),
  state text not null default 'pending' check (state in ('pending','adopted','started','succeeded','failed','uncertain','cancelled','blocked')),
  state_reason text check (state_reason is null or char_length(state_reason) <= 500),
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, plan_id, partition_id),
  unique (workspace_id, plan_id, ordinal),
  unique (workspace_id, child_operation_id),
  foreign key (workspace_id, plan_id) references platform.mixed_parent_plans (workspace_id, plan_id),
  foreign key (workspace_id, child_operation_id) references platform.operations (workspace_id, id),
  check ((state = 'pending') = (child_operation_id is null) or state = 'blocked')
);
create index if not exists mixed_child_plans_operation on platform.mixed_child_plans (workspace_id, child_operation_id) where child_operation_id is not null;

create table if not exists platform.mixed_child_receipts (
  workspace_id text not null,
  plan_id text not null,
  partition_id text not null,
  receipt_id text not null check (receipt_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  ordinal integer not null check (ordinal >= 0 and ordinal < 64),
  child_operation_id text not null check (child_operation_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  outcome text not null check (outcome in ('succeeded','failed','uncertain','cancelled')),
  child_status text not null check (char_length(child_status) between 1 and 64),
  executable_semantics_digest text check (executable_semantics_digest is null or executable_semantics_digest ~ '^[a-f0-9]{64}$'),
  plan_digest text check (plan_digest is null or plan_digest ~ '^[a-f0-9]{64}$'),
  outputs_digest text check (outputs_digest is null or outputs_digest ~ '^[a-f0-9]{64}$'),
  receipt_digest text not null check (receipt_digest ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, plan_id, partition_id),
  unique (workspace_id, receipt_id),
  foreign key (workspace_id, plan_id, partition_id) references platform.mixed_child_plans (workspace_id, plan_id, partition_id)
);

create table if not exists platform.mixed_addresses (
  workspace_id text not null,
  plan_id text not null,
  stable_address text not null check (char_length(stable_address) between 3 and 600),
  address text not null check (char_length(address) between 1 and 300),
  partition_id text not null,
  spec_digest text not null check (spec_digest ~ '^[a-f0-9]{64}$'),
  primary key (workspace_id, plan_id, stable_address),
  unique (workspace_id, plan_id, address),
  foreign key (workspace_id, plan_id) references platform.mixed_parent_plans (workspace_id, plan_id),
  foreign key (workspace_id, plan_id, partition_id) references platform.mixed_child_plans (workspace_id, plan_id, partition_id)
);

create or replace function platform.mixed_parent_plan_guard() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception using errcode = '23514', message = 'Mixed parent plans are permanent and cannot be deleted';
  end if;
  if (new.workspace_id, new.plan_id, new.project_id, new.parent_environment_id, new.format, new.graph_digest, new.manifest_digest,
      new.desired_digest, new.parent_digest, new.child_set_digest, new.plan, new.created_by, new.created_at)
     is distinct from
     (old.workspace_id, old.plan_id, old.project_id, old.parent_environment_id, old.format, old.graph_digest, old.manifest_digest,
      old.desired_digest, old.parent_digest, old.child_set_digest, old.plan, old.created_by, old.created_at) then
    raise exception using errcode = '23514', message = 'A mixed parent plan is immutable';
  end if;
  if old.parent_operation_id is not null and new.parent_operation_id is distinct from old.parent_operation_id then
    raise exception using errcode = '23514', message = 'The parent operation of a mixed plan is write-once';
  end if;
  if new.version <> old.version + 1 then
    raise exception using errcode = '23514', message = 'Mixed parent plan updates must advance the version by one';
  end if;
  if new.status is distinct from old.status then
    if old.status = 'planned' and new.status = 'running' and new.parent_operation_id is not null then null;
    elsif old.status = 'planned' and new.status = 'cancelled' then null;
    elsif old.status = 'running' and new.status in ('succeeded','failed','uncertain','cancelled') then null;
    else raise exception using errcode = '23514', message = 'Illegal mixed parent plan transition';
    end if;
  end if;
  new.updated_at = clock_timestamp();
  return new;
end $$;
drop trigger if exists mixed_parent_plan_guard on platform.mixed_parent_plans;
create trigger mixed_parent_plan_guard before update or delete on platform.mixed_parent_plans
  for each row execute function platform.mixed_parent_plan_guard();

create or replace function platform.mixed_child_plan_guard() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception using errcode = '23514', message = 'Mixed child plans are permanent and cannot be deleted';
  end if;
  if (new.workspace_id, new.plan_id, new.partition_id, new.ordinal, new.child_environment_id, new.connection_id, new.provider, new.account_id,
      new.region, new.subplan_digest, new.effect_digest, new.semantics_digest, new.subplan, new.created_at)
     is distinct from
     (old.workspace_id, old.plan_id, old.partition_id, old.ordinal, old.child_environment_id, old.connection_id, old.provider, old.account_id,
      old.region, old.subplan_digest, old.effect_digest, old.semantics_digest, old.subplan, old.created_at) then
    raise exception using errcode = '23514', message = 'A mixed child subplan is immutable';
  end if;
  if old.child_operation_id is not null and new.child_operation_id is distinct from old.child_operation_id then
    raise exception using errcode = '23514', message = 'The child operation of a mixed child is write-once';
  end if;
  if old.executable_semantics_digest is not null and new.executable_semantics_digest is distinct from old.executable_semantics_digest then
    raise exception using errcode = '23514', message = 'The executable semantics digest of a mixed child is write-once';
  end if;
  if new.version <> old.version + 1 then
    raise exception using errcode = '23514', message = 'Mixed child plan updates must advance the version by one';
  end if;
  if old.state in ('succeeded','failed','uncertain','cancelled','blocked') and new.state is distinct from old.state then
    raise exception using errcode = '23514', message = 'A terminal mixed child cannot change state';
  end if;
  if new.state is distinct from old.state then
    if old.state = 'pending' and new.state = 'adopted' and new.child_operation_id is not null then null;
    elsif old.state in ('pending','adopted') and new.state = 'blocked' then null;
    elsif old.state = 'adopted' and new.state = 'started' then null;
    elsif old.state = 'started' and new.state in ('succeeded','failed','uncertain','cancelled')
          and exists (select 1 from platform.mixed_child_receipts r where r.workspace_id = old.workspace_id and r.plan_id = old.plan_id
            and r.partition_id = old.partition_id and r.outcome = new.state) then null;
    else raise exception using errcode = '23514', message = 'Illegal mixed child transition';
    end if;
  end if;
  new.updated_at = clock_timestamp();
  return new;
end $$;
drop trigger if exists mixed_child_plan_guard on platform.mixed_child_plans;
create trigger mixed_child_plan_guard before update or delete on platform.mixed_child_plans
  for each row execute function platform.mixed_child_plan_guard();

create or replace function platform.mixed_append_only() returns trigger language plpgsql as $$
begin
  raise exception using errcode = '23514', message = 'Mixed receipts and addresses cannot be changed or removed';
end $$;
drop trigger if exists mixed_child_receipts_append_only on platform.mixed_child_receipts;
create trigger mixed_child_receipts_append_only before update or delete on platform.mixed_child_receipts
  for each row execute function platform.mixed_append_only();
drop trigger if exists mixed_addresses_append_only on platform.mixed_addresses;
create trigger mixed_addresses_append_only before update or delete on platform.mixed_addresses
  for each row execute function platform.mixed_append_only();

-- A receipt is only meaningful for a child that actually started, under the operation it started with.
create or replace function platform.mixed_child_receipt_guard() returns trigger language plpgsql as $$
declare c platform.mixed_child_plans%rowtype;
begin
  select * into c from platform.mixed_child_plans where workspace_id = new.workspace_id and plan_id = new.plan_id and partition_id = new.partition_id for share;
  if not found or c.state <> 'started' or c.child_operation_id is distinct from new.child_operation_id or c.ordinal <> new.ordinal then
    raise exception using errcode = '23514', message = 'A receipt needs a started child bound to the same operation';
  end if;
  return new;
end $$;
drop trigger if exists mixed_child_receipt_guard on platform.mixed_child_receipts;
create trigger mixed_child_receipt_guard before insert on platform.mixed_child_receipts
  for each row execute function platform.mixed_child_receipt_guard();

alter table platform.mixed_parent_plans enable row level security;
alter table platform.mixed_child_plans enable row level security;
alter table platform.mixed_child_receipts enable row level security;
alter table platform.mixed_addresses enable row level security;
do $$ declare r text; t text; begin
  foreach t in array array['mixed_parent_plans','mixed_child_plans','mixed_child_receipts','mixed_addresses'] loop
    foreach r in array array['anon','authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on table platform.%I from %I', t, r);
      end if;
    end loop;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema platform to service_role;
    revoke all on table platform.mixed_parent_plans from service_role;
    revoke all on table platform.mixed_child_plans from service_role;
    revoke all on table platform.mixed_child_receipts from service_role;
    revoke all on table platform.mixed_addresses from service_role;
    grant select, insert, update on table platform.mixed_parent_plans to service_role;
    grant select, insert, update on table platform.mixed_child_plans to service_role;
    grant select, insert on table platform.mixed_child_receipts to service_role;
    grant select, insert on table platform.mixed_addresses to service_role;
  end if;
end $$;

insert into platform.schema_migrations (version, name, checksum)
values (40, 'mixed_parent_plans', '53231efa3ea0a8275287b0672a1b76845ac1a3196bb2df6678843c61fe5bbd40')
on conflict (version) do nothing;

-- ============================ migration 41: mixed_runs ============================

create table if not exists platform.mixed_runs (
  workspace_id        text        not null,
  parent_operation_id text        not null,
  environment_id      text        not null,
  parent_digest       text        not null check (parent_digest ~ '^[0-9a-f]{64}$'),
  desired_digest      text        not null check (desired_digest ~ '^[0-9a-f]{64}$'),
  state               jsonb       not null check (octet_length(state::text) <= 1048576),
  state_digest        text        not null check (state_digest ~ '^[0-9a-f]{64}$'),
  version             integer     not null default 1 check (version >= 1),
  open                boolean     not null,
  next_deadline_at    timestamptz,
  created_at          timestamptz not null default clock_timestamp(),
  updated_at          timestamptz not null default clock_timestamp(),
  primary key (workspace_id, parent_operation_id),
  foreign key (workspace_id, parent_operation_id) references platform.operations (workspace_id, id),
  check (state->>'workspaceId' = workspace_id and state->>'parentOperationId' = parent_operation_id
    and state->>'environmentId' = environment_id and state->>'desiredDigest' = desired_digest and state->'version' = '1'::jsonb)
);
create index if not exists mixed_runs_due on platform.mixed_runs (next_deadline_at) where open and next_deadline_at is not null;

create or replace function platform.mixed_runs_guard() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Mixed runs are retained' using errcode = '23514';
  end if;
  if (new.workspace_id, new.parent_operation_id, new.environment_id, new.desired_digest, new.created_at)
     is distinct from (old.workspace_id, old.parent_operation_id, old.environment_id, old.desired_digest, old.created_at)
     or new.version <> old.version + 1 then
    raise exception 'Mixed run identity is immutable and version advances by one' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists mixed_runs_guard on platform.mixed_runs;
create trigger mixed_runs_guard before update or delete on platform.mixed_runs
for each row execute function platform.mixed_runs_guard();

create table if not exists platform.mixed_run_events (
  workspace_id        text        not null,
  parent_operation_id text        not null,
  seq                 integer     not null check (seq >= 0),
  kind                text        not null check (kind in ('run_created','start','succeed','fail','outage','tick','cancel','cancel_confirmed',
                                                          'reconciled','retry','rebind','teardown_planned','teardown_released','teardown_result')),
  child_id            text,
  event               jsonb       not null check (octet_length(event::text) <= 65536),
  state_digest        text        not null check (state_digest ~ '^[0-9a-f]{64}$'),
  created_at          timestamptz not null default clock_timestamp(),
  primary key (workspace_id, parent_operation_id, seq),
  foreign key (workspace_id, parent_operation_id) references platform.mixed_runs (workspace_id, parent_operation_id)
);

create or replace function platform.mixed_run_events_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'Mixed run events are append-only' using errcode = '23514';
end
$$;
drop trigger if exists mixed_run_events_immutable on platform.mixed_run_events;
create trigger mixed_run_events_immutable before update or delete on platform.mixed_run_events
for each row execute function platform.mixed_run_events_immutable();

create table if not exists platform.mixed_output_preauthorizations (
  id                      text        not null primary key,
  workspace_id            text        not null,
  environment_id          text        not null,
  parent_operation_id     text        not null,
  created_by              text        not null check (length(created_by) between 1 and 200),
  created_by_name         text        not null check (length(created_by_name) between 1 and 200),
  desired_digest          text        not null check (desired_digest ~ '^[0-9a-f]{64}$'),
  reference_id            text        not null check (length(reference_id) between 1 and 128),
  contract_digest         text        not null check (contract_digest ~ '^[0-9a-f]{64}$'),
  consumer_subplan_digest text        not null check (consumer_subplan_digest ~ '^[0-9a-f]{64}$'),
  producer_subplan_digest text        not null check (producer_subplan_digest ~ '^[0-9a-f]{64}$'),
  value_type              text        not null check (value_type in ('string','number','boolean','resource_id','endpoint','secret_ref')),
  secret_ref              text        check (secret_ref ~ '^vault:[A-Za-z0-9_-]{1,128}/[A-Za-z0-9_-]{1,128}/[A-Za-z0-9_-]{1,128}$'),
  value_digest            text        check (value_digest ~ '^[0-9a-f]{64}$'),
  max_uses                integer     not null check (max_uses between 1 and 10),
  uses                    integer     not null default 0 check (uses >= 0),
  expires_at              timestamptz not null,
  created_at              timestamptz not null,
  status                  text        not null default 'active' check (status in ('active','revoked')),
  revoked_at              timestamptz,
  revoked_by              text,
  revoked_reason          text        check (revoked_reason is null or length(revoked_reason) <= 300),
  unique (workspace_id, id),
  foreign key (workspace_id, parent_operation_id) references platform.operations (workspace_id, id),
  check (uses <= max_uses),
  check ((value_type = 'secret_ref') = (secret_ref is not null)),
  check (expires_at > created_at and expires_at <= created_at + interval '7 days'),
  check ((status = 'revoked') = (revoked_at is not null))
);
create index if not exists mixed_output_preauthorizations_parent on platform.mixed_output_preauthorizations (workspace_id, parent_operation_id, created_at);

create or replace function platform.mixed_output_preauthorizations_guard() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Output preauthorizations are retained' using errcode = '23514';
  end if;
  if (new.id, new.workspace_id, new.environment_id, new.parent_operation_id, new.created_by, new.desired_digest, new.reference_id, new.contract_digest,
      new.consumer_subplan_digest, new.producer_subplan_digest, new.value_type, new.secret_ref, new.value_digest, new.max_uses, new.expires_at, new.created_at)
     is distinct from
     (old.id, old.workspace_id, old.environment_id, old.parent_operation_id, old.created_by, old.desired_digest, old.reference_id, old.contract_digest,
      old.consumer_subplan_digest, old.producer_subplan_digest, old.value_type, old.secret_ref, old.value_digest, old.max_uses, old.expires_at, old.created_at)
     or new.uses < old.uses or (old.status = 'revoked' and new.status <> 'revoked') then
    raise exception 'Output preauthorization bounds are immutable' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists mixed_output_preauthorizations_guard on platform.mixed_output_preauthorizations;
create trigger mixed_output_preauthorizations_guard before update or delete on platform.mixed_output_preauthorizations
for each row execute function platform.mixed_output_preauthorizations_guard();

alter table platform.mixed_runs enable row level security;
alter table platform.mixed_run_events enable row level security;
alter table platform.mixed_output_preauthorizations enable row level security;
do $$
declare r text;
declare t text;
begin
  foreach t in array array['mixed_runs','mixed_run_events','mixed_output_preauthorizations'] loop
    foreach r in array array['anon','authenticated'] loop
      if exists(select 1 from pg_roles where rolname=r) then
        execute format('revoke all on table platform.%I from %I',t,r);
      end if;
    end loop;
    if exists(select 1 from pg_roles where rolname='service_role') then
      execute format('revoke all on table platform.%I from service_role',t);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant select,insert,update on table platform.mixed_runs to service_role;
    grant select,insert on table platform.mixed_run_events to service_role;
    grant select,insert,update on table platform.mixed_output_preauthorizations to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (41, 'mixed_runs', 'adf77c2f92db4d7c74a58b4a056482a66866f12e43909eaf34f9c008a884cff8')
on conflict (version) do nothing;

-- ============================ migration 42: external_effect_key_bounds ============================

alter table platform.external_effects
  drop constraint if exists external_effects_dedup_key_check,
  drop constraint if exists external_effects_idempotency_token_check,
  add constraint external_effects_dedup_key_check
    check (char_length(dedup_key) between 1 and 256 and dedup_key ~ '^[A-Za-z0-9_.:/=+-]+$'),
  add constraint external_effects_idempotency_token_check
    check (idempotency_token is null or
      (char_length(idempotency_token) between 1 and 256 and idempotency_token ~ '^[A-Za-z0-9_.:-]+$'));

insert into platform.schema_migrations (version, name, checksum)
values (42, 'external_effect_key_bounds', '3dcc8f12119594941f82dd749f5471fb2578f1d5c37ec09083491aa6dc91f4b2')
on conflict (version) do nothing;

-- ============================ migration 43: mcp_stream_events_tenant_index ============================

create index if not exists mcp_stream_events_workspace_stream
  on platform.mcp_stream_events(workspace_id, stream_id, seq);

insert into platform.schema_migrations (version, name, checksum)
values (43, 'mcp_stream_events_tenant_index', '903751ca1e2e2fff64979f699e6c44c6c98502f90374b788686e77ee080249cd')
on conflict (version) do nothing;

-- ============================ migration 44: mixed_output_records ============================

create table if not exists platform.mixed_output_records (
  workspace_id            text        not null,
  plan_id                 text        not null,
  reference_id            text        not null check (char_length(reference_id) between 1 and 200),
  producer_partition_id   text        not null,
  consumer_partition_id   text        not null,
  producer_operation_id   text        not null,
  producer_address        text        not null check (char_length(producer_address) between 1 and 300),
  producer_output         text        not null check (char_length(producer_output) between 1 and 512),
  value_type              text        not null check (value_type in ('string','number','boolean','resource_id','endpoint','secret_ref')),
  value_digest            text        not null check (value_digest ~ '^[a-f0-9]{64}$'),
  value                   jsonb       check (value is null or (jsonb_typeof(value) = 'object' and coalesce(jsonb_typeof(value->'v') in ('string','number','boolean'), false) and octet_length(value::text) <= 4096)),
  secret_ref              text        check (secret_ref ~ '^vault:[A-Za-z0-9_-]{1,128}/[A-Za-z0-9_-]{1,128}/[A-Za-z0-9_-]{1,128}$'),
  secret_version_digest   text        check (secret_version_digest ~ '^[a-f0-9]{64}$'),
  source                  text        not null check (source in ('observation','tofu_output')),
  source_digest           text        not null check (source_digest ~ '^[a-f0-9]{64}$'),
  observed_at             timestamptz not null,
  recorded_at             timestamptz not null default clock_timestamp(),
  primary key (workspace_id, plan_id, reference_id),
  foreign key (workspace_id, plan_id) references platform.mixed_parent_plans (workspace_id, plan_id),
  foreign key (workspace_id, plan_id, producer_partition_id) references platform.mixed_child_plans (workspace_id, plan_id, partition_id),
  foreign key (workspace_id, plan_id, consumer_partition_id) references platform.mixed_child_plans (workspace_id, plan_id, partition_id),
  check ((value_type = 'secret_ref') = (secret_ref is not null)),
  check ((value_type = 'secret_ref') = (value is null)),
  check ((secret_ref is null) = (secret_version_digest is null))
);
create index if not exists mixed_output_records_plan on platform.mixed_output_records (workspace_id, plan_id, recorded_at);

create or replace function platform.mixed_output_records_immutable() returns trigger language plpgsql as $$
begin
  raise exception using errcode = '23514', message = 'Mixed output records are append-only';
end $$;
drop trigger if exists mixed_output_records_immutable on platform.mixed_output_records;
create trigger mixed_output_records_immutable before update or delete on platform.mixed_output_records
  for each row execute function platform.mixed_output_records_immutable();

alter table platform.mixed_output_records enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.mixed_output_records from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.mixed_output_records from service_role;
    grant select,insert on table platform.mixed_output_records to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (44, 'mixed_output_records', '027e9fdbaced8902ee63d9c551ecfb812bd1fd7d96ea0356497200bac336d0d2')
on conflict (version) do nothing;

-- ============================ migration 45: slo_measurements ============================

create table if not exists platform.slo_samples (
  sli          text        not null check (sli ~ '^[a-z][a-z0-9_]{0,63}$'),
  bucket_start timestamptz not null,
  good         bigint      not null default 0 check (good >= 0),
  total        bigint      not null default 0 check (total >= 0),
  updated_at   timestamptz not null default clock_timestamp(),
  primary key (sli, bucket_start),
  check (good <= total)
);

create table if not exists platform.slo_measurements (
  seq         bigint generated always as identity primary key,
  id          text        not null unique check (id ~ '^[A-Za-z0-9_-]{8,64}$'),
  kind        text        not null check (kind in ('rpo','rto','capacity')),
  source      text        not null check (source in ('restore-rehearsal','recovery-drill','capacity-test','manual')),
  value       double precision not null check (value >= 0),
  unit        text        not null check (unit in ('seconds','requests_per_second')),
  within_target boolean,
  target_version text     check (target_version is null or char_length(target_version) <= 64),
  recorded_by text        not null check (char_length(recorded_by) between 1 and 128),
  details     jsonb       not null default '{}'::jsonb check (octet_length(details::text) <= 4096),
  measured_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  check ((kind in ('rpo','rto') and unit = 'seconds') or (kind = 'capacity' and unit = 'requests_per_second'))
);
create index if not exists slo_measurements_kind_seq on platform.slo_measurements (kind, seq desc);

create or replace function platform.slo_measurements_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'SLO measurements are append-only' using errcode = '23514';
end
$$;
drop trigger if exists slo_measurements_immutable on platform.slo_measurements;
create trigger slo_measurements_immutable before update or delete on platform.slo_measurements
for each row execute function platform.slo_measurements_immutable();

alter table platform.slo_samples enable row level security;
alter table platform.slo_measurements enable row level security;
do $$
declare r text; t text;
begin
  foreach t in array array['slo_samples','slo_measurements'] loop
    foreach r in array array['anon','authenticated'] loop
      if exists(select 1 from pg_roles where rolname=r) then
        execute format('revoke all on table platform.%I from %I', t, r);
      end if;
    end loop;
    if exists(select 1 from pg_roles where rolname='service_role') then
      execute format('revoke all on table platform.%I from service_role', t);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant select,insert,update,delete on table platform.slo_samples to service_role;
    grant select,insert on table platform.slo_measurements to service_role;
    grant usage on all sequences in schema platform to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (45, 'slo_measurements', '1494c27a7ce8bdb8ca49b9c78cdf68e8e4bb7d3879e92f9e0a25a90bd55c5bf6')
on conflict (version) do nothing;

-- ============================ migration 46: recovery_epochs ============================

create table if not exists platform.recovery_epochs (
  epoch           bigint      not null primary key check (epoch >= 0 and epoch <= 9000),
  kind            text        not null check (kind in ('genesis','restore')),
  actor           text        not null check (char_length(actor) between 1 and 200),
  reason          text        not null check (char_length(reason) between 1 and 500),
  restore_run_id  text        unique check (restore_run_id is null or restore_run_id ~ '^[A-Za-z0-9_.:-]{8,128}$'),
  manifest_digest text        check (manifest_digest is null or manifest_digest ~ '^[a-f0-9]{64}$'),
  backup_id       text        check (backup_id is null or char_length(backup_id) between 1 and 128),
  backup_taken_at timestamptz,
  prior_epoch     bigint      check (prior_epoch is null or prior_epoch >= 0),
  observed_epoch  bigint      check (observed_epoch is null or observed_epoch >= 0),
  created_at      timestamptz not null default clock_timestamp(),
  check ((kind = 'genesis') = (epoch = 0)),
  check (kind = 'genesis' or restore_run_id is not null)
);
insert into platform.recovery_epochs (epoch, kind, actor, reason)
values (0, 'genesis', 'migration', 'initial recovery epoch')
on conflict (epoch) do nothing;

create or replace function platform.recovery_epochs_append_only() returns trigger language plpgsql as $$
begin
  raise exception using errcode = '23514', message = 'Recovery epochs are append-only';
end $$;
drop trigger if exists recovery_epochs_append_only on platform.recovery_epochs;
create trigger recovery_epochs_append_only before update or delete on platform.recovery_epochs
  for each row execute function platform.recovery_epochs_append_only();

create or replace function platform.current_recovery_epoch() returns bigint language sql stable as $$
  select coalesce(max(epoch), 0)::bigint from platform.recovery_epochs
$$;
create or replace function platform.recovery_fence_floor() returns bigint language sql stable as $$
  select platform.current_recovery_epoch() * 1000000000::bigint + 1
$$;

alter table platform.operations add column if not exists recovery_epoch bigint not null default platform.current_recovery_epoch();
alter table platform.approvals add column if not exists recovery_epoch bigint not null default platform.current_recovery_epoch();
alter table platform.durable_intents add column if not exists recovery_epoch bigint not null default platform.current_recovery_epoch();
alter table platform.external_effects add column if not exists recovery_epoch bigint not null default platform.current_recovery_epoch();

create table if not exists platform.recovery_items (
  id            text        not null primary key check (id ~ '^ri_[a-f0-9]{40}$'),
  workspace_id  text        not null check (char_length(workspace_id) between 1 and 128),
  epoch         bigint      not null references platform.recovery_epochs (epoch),
  kind          text        not null check (kind in ('operation','intent','effect')),
  ref           text        not null check (char_length(ref) between 1 and 200),
  environment_id text       check (environment_id is null or char_length(environment_id) between 1 and 128),
  prior_state   text        not null check (char_length(prior_state) between 1 and 64),
  allowed       text[]      not null check (allowed <@ array['resume','abandon','keep_uncertain']::text[] and cardinality(allowed) >= 1),
  state         text        not null default 'pending' check (state in ('pending','resumed','abandoned','kept_uncertain')),
  decided_by    text        check (decided_by is null or char_length(decided_by) between 1 and 200),
  decision_reason text      check (decision_reason is null or char_length(decision_reason) between 1 and 500),
  decision_digest text      check (decision_digest is null or decision_digest ~ '^[a-f0-9]{64}$'),
  decided_at    timestamptz,
  created_at    timestamptz not null default clock_timestamp(),
  unique (epoch, workspace_id, kind, ref),
  check ((state = 'pending') = (decided_at is null)),
  check (state = 'pending' or (decided_by is not null and decision_reason is not null and decision_digest is not null))
);
create index if not exists recovery_items_ws_state on platform.recovery_items (workspace_id, state, epoch);

create or replace function platform.recovery_item_guard() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception using errcode = '23514', message = 'Recovery items cannot be deleted';
  end if;
  if (new.id, new.workspace_id, new.epoch, new.kind, new.ref, new.prior_state, new.allowed, new.created_at)
     is distinct from (old.id, old.workspace_id, old.epoch, old.kind, old.ref, old.prior_state, old.allowed, old.created_at) then
    raise exception using errcode = '23514', message = 'Recovery item identity is immutable';
  end if;
  if old.state <> 'pending' and new is distinct from old then
    raise exception using errcode = '23514', message = 'A decided recovery item cannot change';
  end if;
  if new.state <> 'pending' and not (new.state = 'resumed' and 'resume' = any(new.allowed)
       or new.state = 'abandoned' and 'abandon' = any(new.allowed)
       or new.state = 'kept_uncertain' and 'keep_uncertain' = any(new.allowed)) then
    raise exception using errcode = '23514', message = 'That decision is not allowed for this recovery item';
  end if;
  return new;
end $$;
drop trigger if exists recovery_item_guard on platform.recovery_items;
create trigger recovery_item_guard before update or delete on platform.recovery_items
  for each row execute function platform.recovery_item_guard();

alter table platform.recovery_epochs enable row level security;
alter table platform.recovery_items enable row level security;
do $$
declare r text; t text;
begin
  foreach t in array array['recovery_epochs','recovery_items'] loop
    foreach r in array array['anon','authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on table platform.%I from %I', t, r);
      end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on table platform.%I from service_role', t);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema platform to service_role;
    grant select, insert on table platform.recovery_epochs to service_role;
    grant select, insert, update on table platform.recovery_items to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (46, 'recovery_epochs', 'b60c5b5fd4ae95b2e7e3b14d503d0def9904561fceb73f8432c9984717ef4daf')
on conflict (version) do nothing;

-- ============================ migration 47: retention ============================

create table if not exists platform.legal_holds (
  id             text        not null primary key,
  workspace_id   text        not null,
  data_class     text        check (data_class is null or data_class in ('runner_job_logs','machine_request_logs','resource_observations','drift_reports')),
  resource_ref   text        check (resource_ref is null or char_length(resource_ref) between 1 and 200),
  time_from      timestamptz,
  time_to        timestamptz,
  reason         text        not null check (char_length(reason) between 1 and 500),
  created_by     text        not null check (char_length(created_by) between 1 and 128),
  created_at     timestamptz not null default clock_timestamp(),
  released_at    timestamptz,
  released_by    text,
  release_reason text        check (release_reason is null or char_length(release_reason) <= 500),
  check (time_from is null or time_to is null or time_to >= time_from),
  check ((released_at is null and released_by is null) or (released_at is not null and released_by is not null))
);
create index if not exists legal_holds_active on platform.legal_holds (workspace_id) where released_at is null;

create or replace function platform.legal_holds_guard() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Legal holds are retained' using errcode = '23514';
  end if;
  if (new.id, new.workspace_id, new.data_class, new.resource_ref, new.time_from, new.time_to, new.reason, new.created_by, new.created_at)
     is distinct from (old.id, old.workspace_id, old.data_class, old.resource_ref, old.time_from, old.time_to, old.reason, old.created_by, old.created_at) then
    raise exception 'A legal hold can only be released, not edited' using errcode = '23514';
  end if;
  if old.released_at is not null then
    raise exception 'A released legal hold stays released' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists legal_holds_guard on platform.legal_holds;
create trigger legal_holds_guard before update or delete on platform.legal_holds
for each row execute function platform.legal_holds_guard();

create table if not exists platform.retention_archives (
  id                  text        not null primary key,
  workspace_id        text        not null,
  data_class          text        not null check (data_class in ('runner_job_logs','machine_request_logs','resource_observations','drift_reports')),
  object_key          text        not null check (char_length(object_key) <= 512),
  rows_digest         text        not null check (rows_digest ~ '^[0-9a-f]{64}$'),
  row_count           integer     not null check (row_count >= 1),
  first_row_id        text        not null,
  last_row_id         text        not null,
  last_recorded_at    timestamptz not null,
  key_id              text        not null,
  destination_id      text,
  destination_label   text        not null default 'operator storage',
  policy_digest      text        not null check (policy_digest ~ '^[0-9a-f]{64}$'),
  created_at          timestamptz not null default clock_timestamp(),
  verified_at         timestamptz not null default clock_timestamp(),
  pruned_rows         integer     not null default 0 check (pruned_rows >= 0),
  completed_at        timestamptz,
  next_prune_check_at timestamptz,
  unique (workspace_id, data_class, object_key)
);
create index if not exists retention_archives_ws_class on platform.retention_archives (workspace_id, data_class, last_recorded_at desc);
create index if not exists retention_archives_pending on platform.retention_archives (next_prune_check_at) where completed_at is null;

create or replace function platform.retention_archives_guard() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Retention archive records are retained' using errcode = '23514';
  end if;
  if (new.id, new.workspace_id, new.data_class, new.object_key, new.rows_digest, new.row_count, new.first_row_id, new.last_row_id, new.last_recorded_at, new.key_id, new.destination_id, new.destination_label, new.policy_digest, new.created_at, new.verified_at)
     is distinct from (old.id, old.workspace_id, old.data_class, old.object_key, old.rows_digest, old.row_count, old.first_row_id, old.last_row_id, old.last_recorded_at, old.key_id, old.destination_id, old.destination_label, old.policy_digest, old.created_at, old.verified_at)
     or new.pruned_rows < old.pruned_rows or (old.completed_at is not null and new.completed_at is distinct from old.completed_at) then
    raise exception 'Retention archive identity is immutable and pruned_rows only grows' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists retention_archives_guard on platform.retention_archives;
create trigger retention_archives_guard before update or delete on platform.retention_archives
for each row execute function platform.retention_archives_guard();

create table if not exists platform.retention_destinations (
  id               text        not null primary key,
  workspace_id     text        not null,
  environment_id   text        not null,
  resource_address text        not null check (char_length(resource_address) between 1 and 300),
  credentials_ref  text        not null check (char_length(credentials_ref) between 1 and 1024),
  bucket           text        not null check (char_length(bucket) between 3 and 63),
  created_by       text        not null,
  created_at       timestamptz not null default clock_timestamp(),
  revoked_at       timestamptz,
  revoked_by       text,
  check ((revoked_at is null and revoked_by is null) or (revoked_at is not null and revoked_by is not null))
);
create unique index if not exists retention_destinations_active on platform.retention_destinations (workspace_id) where revoked_at is null;

create or replace function platform.retention_destinations_guard() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Retention destinations are retained' using errcode = '23514';
  end if;
  if (new.id, new.workspace_id, new.environment_id, new.resource_address, new.credentials_ref, new.bucket, new.created_by, new.created_at)
     is distinct from (old.id, old.workspace_id, old.environment_id, old.resource_address, old.credentials_ref, old.bucket, old.created_by, old.created_at)
     or old.revoked_at is not null then
    raise exception 'A retention destination can only be revoked, once' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists retention_destinations_guard on platform.retention_destinations;
create trigger retention_destinations_guard before update or delete on platform.retention_destinations
for each row execute function platform.retention_destinations_guard();

create table if not exists platform.retention_restores (
  id                      text        not null primary key,
  workspace_id            text        not null,
  archive_id              text        not null references platform.retention_archives (id),
  data_class              text        not null,
  mode                    text        not null check (mode in ('staging','source','verify')),
  staging_schema          text,
  requested_by            text        not null,
  rows_selected           integer     not null default 0,
  rows_inserted           integer     not null default 0,
  rows_existing_identical integer     not null default 0,
  rows_existing_differ    integer     not null default 0,
  rows_skipped_no_parent  integer     not null default 0,
  verdict                 text        not null check (verdict in ('verified','mismatch','refused')),
  detail                  text,
  created_at              timestamptz not null default clock_timestamp()
);
create index if not exists retention_restores_workspace on platform.retention_restores (workspace_id, created_at desc);
create index if not exists retention_restores_archive on platform.retention_restores (archive_id, created_at desc);

create or replace function platform.retention_restores_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'Retention restore records are append-only' using errcode = '23514';
end
$$;
drop trigger if exists retention_restores_immutable on platform.retention_restores;
create trigger retention_restores_immutable before update or delete on platform.retention_restores
for each row execute function platform.retention_restores_immutable();

alter table platform.legal_holds enable row level security;
alter table platform.retention_archives enable row level security;
alter table platform.retention_destinations enable row level security;
alter table platform.retention_restores enable row level security;
do $$ declare r text; t text; begin
  foreach t in array array['legal_holds','retention_archives','retention_destinations','retention_restores'] loop
    foreach r in array array['anon','authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on table platform.%I from %I', t, r);
      end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke delete, truncate on table platform.%I from service_role', t);
    end if;
  end loop;
end $$;

insert into platform.schema_migrations (version, name, checksum)
values (47, 'retention', '6be0f7bd6711cc5a37507541488bb09305d181823398929ed29e3aa9c8295909')
on conflict (version) do nothing;

-- ============================ migration 48: audit_exports ============================

create table if not exists platform.audit_exports (
  seq                bigint generated always as identity,
  id                 text        not null primary key check (id ~ '^[A-Za-z0-9_-]{1,100}$'),
  workspace_id       text        not null check (char_length(workspace_id) between 1 and 128),
  range_from         timestamptz,
  range_to           timestamptz,
  event_count        integer     not null check (event_count >= 0),
  genesis            text        not null check (genesis ~ '^[0-9a-f]{64}$'),
  head               text        not null check (head ~ '^[0-9a-f]{64}$'),
  previous_export_id text,
  previous_head      text        check (previous_head is null or previous_head ~ '^[0-9a-f]{64}$'),
  key_id             text        not null check (char_length(key_id) between 1 and 200),
  signature_digest   text        not null check (signature_digest ~ '^[0-9a-f]{64}$'),
  created_by         text        not null check (char_length(created_by) between 1 and 200),
  created_at         timestamptz not null default clock_timestamp(),
  unique (workspace_id, id),
  foreign key (workspace_id, previous_export_id) references platform.audit_exports (workspace_id, id),
  check ((previous_export_id is null) = (previous_head is null)),
  check (range_from is null or range_to is null or range_from <= range_to)
);
create unique index if not exists audit_exports_one_successor on platform.audit_exports (workspace_id, previous_export_id) where previous_export_id is not null;
create unique index if not exists audit_exports_one_root on platform.audit_exports (workspace_id) where previous_export_id is null;
create index if not exists audit_exports_ws on platform.audit_exports (workspace_id, seq desc);

create or replace function platform.audit_exports_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'Audit export records are append-only' using errcode = '23514';
end
$$;
drop trigger if exists audit_exports_immutable on platform.audit_exports;
create trigger audit_exports_immutable before update or delete on platform.audit_exports
for each row execute function platform.audit_exports_immutable();

alter table platform.audit_exports enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.audit_exports from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.audit_exports from service_role;
    grant select,insert on table platform.audit_exports to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (48, 'audit_exports', '44d625c45bf2e665cd424e96394d739a3d9733ce4a37a8812ff0fbedccae4fba')
on conflict (version) do nothing;

-- ============================ migration 49: managed_source_provider ============================

do $$
declare
  c record;
  widened text;
  found boolean := false;
begin
  for c in
    select conname, pg_get_constraintdef(oid) as def
      from pg_constraint
     where conrelid = 'platform.approved_source_snapshots'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) like '%''azure''::text%'
       and pg_get_constraintdef(oid) like '%tar.gz%'
  loop
    found := true;
    if c.def like '%''zenith''::text%' then
      continue;
    end if;
    widened := replace(c.def, '''azure''::text]', '''azure''::text, ''zenith''::text]');
    if widened = c.def then
      raise exception 'approved_source_snapshots provider constraint has an unexpected shape';
    end if;
    execute format('alter table platform.approved_source_snapshots drop constraint %I', c.conname);
    execute format('alter table platform.approved_source_snapshots add constraint %I %s', c.conname, widened);
  end loop;
  if not found then
    raise exception 'approved_source_snapshots provider constraint was not found';
  end if;
end $$;

insert into platform.schema_migrations (version, name, checksum)
values (49, 'managed_source_provider', '2ff01c3f1ccb9c4ed33122b7cfccfcb486aba0cec508dd9e555f62396b1a6313')
on conflict (version) do nothing;

-- ============================ migration 50: managed_serving ============================

create table if not exists platform.managed_domains (
  id                  text        not null primary key,
  workspace_id        text        not null check (char_length(workspace_id) between 1 and 128),
  environment_id      text        not null check (char_length(environment_id) between 1 and 128),
  hostname            text        not null check (hostname ~ '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])$'),
  status              text        not null default 'pending' check (status in ('pending','verified','lapsed','revoked')),
  challenge_hash      text        not null check (challenge_hash ~ '^[0-9a-f]{64}$'),
  challenge_issued_at timestamptz not null default clock_timestamp(),
  verified_at         timestamptz,
  expires_at          timestamptz,
  last_checked_at     timestamptz,
  last_outcome        text        check (last_outcome is null or last_outcome in ('verified','not_found','mismatch','uncertain')),
  failure_count       integer     not null default 0 check (failure_count >= 0),
  lapsed_at           timestamptz,
  revoked_at          timestamptz,
  revoked_by          text        check (revoked_by is null or char_length(revoked_by) between 1 and 200),
  requested_by        text        not null check (char_length(requested_by) between 1 and 200),
  created_at          timestamptz not null default clock_timestamp(),
  updated_at          timestamptz not null default clock_timestamp(),
  unique (workspace_id, id),
  check (status <> 'verified' or (verified_at is not null and expires_at is not null)),
  check (status <> 'lapsed' or lapsed_at is not null),
  check (status <> 'revoked' or revoked_at is not null)
);
-- a hostname is served for at most one workspace at a time, whoever asks
create unique index if not exists managed_domains_verified_host on platform.managed_domains (hostname) where status = 'verified';
-- one live claim per environment and hostname (a re-claim of a pending row re-issues its challenge)
create unique index if not exists managed_domains_live_claim on platform.managed_domains (workspace_id, environment_id, hostname) where status in ('pending','verified');
create index if not exists managed_domains_env on platform.managed_domains (workspace_id, environment_id, created_at desc);
create index if not exists managed_domains_due on platform.managed_domains (expires_at) where status = 'verified';

create table if not exists platform.managed_storage_keys (
  id             text        not null primary key,
  workspace_id   text        not null check (char_length(workspace_id) between 1 and 128),
  environment_id text        not null check (char_length(environment_id) between 1 and 128),
  address        text        not null check (char_length(address) between 1 and 500),
  bucket         text        not null check (char_length(bucket) between 3 and 63),
  prefix         text        not null check (char_length(prefix) between 2 and 500 and right(prefix, 1) = '/'),
  policy_digest  text        not null check (policy_digest ~ '^[0-9a-f]{64}$'),
  principal_name text        not null check (char_length(principal_name) between 1 and 64),
  access_key_id  text        not null check (char_length(access_key_id) between 1 and 128),
  secret_ref     text        not null check (char_length(secret_ref) between 7 and 306 and secret_ref ~ '^vault:[A-Za-z0-9._/-]+$'),
  status         text        not null default 'active' check (status in ('active','revoke_pending','revoked')),
  created_at     timestamptz not null default clock_timestamp(),
  superseded_at  timestamptz,
  revoked_at     timestamptz,
  unique (workspace_id, id),
  check (status <> 'revoked' or revoked_at is not null)
);
create unique index if not exists managed_storage_keys_active on platform.managed_storage_keys (workspace_id, environment_id, address) where status = 'active';
create index if not exists managed_storage_keys_env on platform.managed_storage_keys (workspace_id, environment_id, created_at desc);
create index if not exists managed_storage_keys_pending on platform.managed_storage_keys (created_at) where status = 'revoke_pending';

alter table platform.managed_domains enable row level security;
alter table platform.managed_storage_keys enable row level security;
do $$
declare r text; t text;
begin
  foreach t in array array['managed_domains','managed_storage_keys'] loop
    foreach r in array array['anon','authenticated'] loop
      if exists(select 1 from pg_roles where rolname=r) then
        execute format('revoke all on table platform.%I from %I',t,r);
      end if;
    end loop;
    if exists(select 1 from pg_roles where rolname='service_role') then
      execute format('revoke all on table platform.%I from service_role',t);
      execute format('grant select,insert,update on table platform.%I to service_role',t);
    end if;
  end loop;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (50, 'managed_serving', '84fd09e1866b387eb422173d38da18dd97aa7f5b967da8eb02f452a38ea99804')
on conflict (version) do nothing;

-- ============================ migration 51: tenant_isolation_effects ============================

alter table platform.external_effects drop constraint if exists external_effects_family_check;
alter table platform.external_effects add constraint external_effects_family_check
  check (family in ('build_launch','cleanup_apply','proxy_request','isolation_apply'));

insert into platform.schema_migrations (version, name, checksum)
values (51, 'tenant_isolation_effects', '78d3690342ffc5f35e73f67566ccfc48087095cfec2acf191468e560a99bb16a')
on conflict (version) do nothing;

-- ============================ migration 52: billing ============================

create table if not exists platform.billing_accounts (
  workspace_id       text        not null primary key,
  plan_id            text        not null check (plan_id ~ '^[a-z0-9_]{1,64}$'),
  status             text        not null default 'active' check (status in ('active','past_due','suspended')),
  suspension_reason  text        check (suspension_reason in ('nonpayment','operator')),
  past_due_since     timestamptz,
  suspended_at       timestamptz,
  stripe_customer_id text        check (stripe_customer_id ~ '^[A-Za-z0-9_]{1,100}$'),
  assigned_by        text        not null check (length(assigned_by) between 1 and 200),
  version            integer     not null default 1 check (version >= 1),
  created_at         timestamptz not null default clock_timestamp(),
  updated_at         timestamptz not null default clock_timestamp(),
  check ((status = 'suspended') = (suspension_reason is not null and suspended_at is not null)),
  check (status = 'suspended' or (suspension_reason is null and suspended_at is null))
);

create or replace function platform.billing_accounts_guard() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Billing accounts are retained' using errcode = '23514';
  end if;
  if new.workspace_id <> old.workspace_id or new.created_at <> old.created_at or new.version <> old.version + 1 then
    raise exception 'Billing account identity is immutable and version advances by one' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists billing_accounts_guard on platform.billing_accounts;
create trigger billing_accounts_guard before update or delete on platform.billing_accounts
for each row execute function platform.billing_accounts_guard();

create table if not exists platform.billing_account_events (
  seq          bigint generated always as identity primary key,
  workspace_id text        not null,
  kind         text        not null check (kind in ('plan_assigned','past_due','suspended','reinstated','payment_received','export_requested')),
  actor        text        not null check (length(actor) between 1 and 200),
  reason       text        check (reason is null or length(reason) <= 300),
  detail       jsonb       not null default '{}'::jsonb check (octet_length(detail::text) <= 16384),
  at           timestamptz not null default clock_timestamp()
);
create index if not exists billing_account_events_ws on platform.billing_account_events (workspace_id, seq desc);

create or replace function platform.billing_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'Billing records are append-only' using errcode = '23514';
end
$$;
drop trigger if exists billing_account_events_immutable on platform.billing_account_events;
create trigger billing_account_events_immutable before update or delete on platform.billing_account_events
for each row execute function platform.billing_append_only();

create table if not exists platform.billing_invoices (
  id                  text        not null primary key,
  workspace_id        text        not null,
  period              text        not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  plan_id             text        not null check (plan_id ~ '^[a-z0-9_]{1,64}$'),
  plan_provisional    boolean     not null,
  currency            text        not null check (currency = 'usd'),
  lines               jsonb       not null check (jsonb_typeof(lines) = 'array' and octet_length(lines::text) <= 262144),
  subtotal_cents      bigint      not null check (subtotal_cents >= 0),
  digest              text        not null check (digest ~ '^[0-9a-f]{64}$'),
  status              text        not null default 'draft' check (status in ('draft','open','paid','failed','void','no_charge')),
  stripe_invoice_id   text        check (stripe_invoice_id ~ '^[A-Za-z0-9_]{1,100}$'),
  stripe_customer_id  text        check (stripe_customer_id ~ '^[A-Za-z0-9_]{1,100}$'),
  attempts            integer     not null default 0 check (attempts >= 0),
  due_at              timestamptz,
  paid_at             timestamptz,
  amount_paid_cents   bigint      check (amount_paid_cents is null or amount_paid_cents >= 0),
  last_event_created  bigint      not null default 0,
  last_error          text        check (last_error is null or length(last_error) <= 300),
  version             integer     not null default 1 check (version >= 1),
  created_at          timestamptz not null default clock_timestamp(),
  updated_at          timestamptz not null default clock_timestamp(),
  unique (workspace_id, id),
  unique (workspace_id, period),
  unique (stripe_invoice_id),
  check ((status = 'paid') = (paid_at is not null)),
  check (status in ('draft','no_charge','void') or stripe_invoice_id is not null)
);
create index if not exists billing_invoices_standing on platform.billing_invoices (workspace_id, status, due_at) where status in ('open','failed');

create or replace function platform.billing_invoices_guard() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Invoices are retained' using errcode = '23514';
  end if;
  if (new.id, new.workspace_id, new.period, new.plan_id, new.plan_provisional, new.currency, new.lines, new.subtotal_cents, new.digest, new.created_at)
     is distinct from
     (old.id, old.workspace_id, old.period, old.plan_id, old.plan_provisional, old.currency, old.lines, old.subtotal_cents, old.digest, old.created_at)
     or new.version <> old.version + 1 then
    raise exception 'Invoice content is immutable and version advances by one' using errcode = '23514';
  end if;
  if old.status = 'paid' and new.status <> 'paid' then
    raise exception 'A paid invoice does not change status' using errcode = '23514';
  end if;
  if old.status in ('void','no_charge') and new.status <> old.status then
    raise exception 'A closed invoice does not change status' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists billing_invoices_guard on platform.billing_invoices;
create trigger billing_invoices_guard before update or delete on platform.billing_invoices
for each row execute function platform.billing_invoices_guard();

create table if not exists platform.billing_usage_events (
  id           text          not null primary key,
  workspace_id text          not null,
  meter        text          not null check (meter in ('managed_resource_hours','build_minutes','storage_gb_month','operations_executed','egress_gb_estimated')),
  source_id    text          not null check (length(source_id) between 1 and 300),
  period       text          not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  quantity     numeric(20,6) not null check (quantity >= 0),
  unit         text          not null check (length(unit) between 1 and 40),
  estimated    boolean       not null default false,
  detail       jsonb         not null default '{}'::jsonb check (octet_length(detail::text) <= 4096),
  observed_at  timestamptz   not null default clock_timestamp(),
  unique (workspace_id, meter, source_id, period)
);
create index if not exists billing_usage_events_ws_period on platform.billing_usage_events (workspace_id, period, meter);

create or replace function platform.billing_usage_events_guard() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Usage records are retained' using errcode = '23514';
  end if;
  if exists (select 1 from platform.billing_invoices i where i.workspace_id = new.workspace_id and i.period = new.period and i.status <> 'void') then
    raise exception 'Usage for an invoiced period is closed' using errcode = '23514';
  end if;
  if TG_OP = 'UPDATE' and (new.id, new.workspace_id, new.meter, new.source_id, new.period) is distinct from (old.id, old.workspace_id, old.meter, old.source_id, old.period) then
    raise exception 'Usage record identity is immutable' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists billing_usage_events_guard on platform.billing_usage_events;
create trigger billing_usage_events_guard before insert or update or delete on platform.billing_usage_events
for each row execute function platform.billing_usage_events_guard();

create table if not exists platform.billing_webhook_events (
  stripe_event_id text        not null primary key check (stripe_event_id ~ '^[A-Za-z0-9_]{1,100}$'),
  event_type      text        not null check (length(event_type) between 1 and 120),
  workspace_id    text,
  payload_sha256  text        not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  stripe_created  bigint      not null,
  outcome         text        not null default 'received' check (outcome in ('received','applied','ignored','unmatched','rejected','amount_mismatch')),
  received_at     timestamptz not null default clock_timestamp()
);

create or replace function platform.billing_webhook_events_guard() returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Webhook events are retained' using errcode = '23514';
  end if;
  if old.outcome <> 'received' or (new.stripe_event_id, new.event_type, new.payload_sha256, new.stripe_created, new.received_at)
     is distinct from (old.stripe_event_id, old.event_type, old.payload_sha256, old.stripe_created, old.received_at) then
    raise exception 'A recorded webhook event is final' using errcode = '23514';
  end if;
  return new;
end
$$;
drop trigger if exists billing_webhook_events_guard on platform.billing_webhook_events;
create trigger billing_webhook_events_guard before update or delete on platform.billing_webhook_events
for each row execute function platform.billing_webhook_events_guard();

alter table platform.billing_accounts enable row level security;
alter table platform.billing_account_events enable row level security;
alter table platform.billing_invoices enable row level security;
alter table platform.billing_usage_events enable row level security;
alter table platform.billing_webhook_events enable row level security;
do $$
declare r text;
declare t text;
begin
  foreach t in array array['billing_accounts','billing_account_events','billing_invoices','billing_usage_events','billing_webhook_events'] loop
    foreach r in array array['anon','authenticated'] loop
      if exists(select 1 from pg_roles where rolname=r) then
        execute format('revoke all on table platform.%I from %I',t,r);
      end if;
    end loop;
    if exists(select 1 from pg_roles where rolname='service_role') then
      execute format('revoke all on table platform.%I from service_role',t);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant select,insert,update on table platform.billing_accounts to service_role;
    grant select,insert on table platform.billing_account_events to service_role;
    grant select,insert,update on table platform.billing_invoices to service_role;
    grant select,insert,update on table platform.billing_usage_events to service_role;
    grant select,insert,update on table platform.billing_webhook_events to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (52, 'billing', '0236a9a6624adff33cce485ef54e4954cec5d629bfbb2fe4a0ccab5a51f5c45f')
on conflict (version) do nothing;

-- ============================ migration 53: field_ownership_serialization ============================

create or replace function platform.serialize_field_ownership() returns trigger
language plpgsql set search_path=pg_catalog as $$
declare
  old_key bigint;
  new_key bigint;
begin
  -- INSERT foreign-key locks precede the environment coordinator, just as
  -- native admission takes its operation lock before that coordinator.
  if TG_TABLE_NAME='ownership_transfers' and TG_OP='INSERT' then
    perform id from platform.operations where workspace_id=new.workspace_id and id=new.operation_id for key share;
    if not found then raise exception 'Ownership transfer operation is unavailable' using errcode='23514'; end if;
    perform id from platform.approvals where workspace_id=new.workspace_id and id=new.approval_id for key share;
    if not found then raise exception 'Ownership transfer approval is unavailable' using errcode='23514'; end if;
  end if;
  if TG_OP<>'INSERT' then
    old_key:=hashtextextended('zenith:field-ownership:' || jsonb_build_array(old.workspace_id,old.environment_id)::text,0);
  end if;
  if TG_OP<>'DELETE' then
    new_key:=hashtextextended('zenith:field-ownership:' || jsonb_build_array(new.workspace_id,new.environment_id)::text,0);
  end if;
  -- A resource moved between environments locks both scopes in key order.
  -- A hash collision only causes extra serialization, never missing exclusion.
  perform pg_advisory_xact_lock(least(old_key,new_key));
  if old_key is not null and new_key is not null and old_key<>new_key then
    perform pg_advisory_xact_lock(greatest(old_key,new_key));
  end if;
  if TG_OP='DELETE' then return old; end if;
  return new;
end
$$;
create or replace trigger field_ownership_resource_serialization
before insert or delete or update of id,workspace_id,environment_id,address,kind,native_type,spec on platform.resources
for each row execute function platform.serialize_field_ownership();
create or replace trigger field_ownership_transfer_serialization
before insert or update or delete on platform.ownership_transfers
for each row execute function platform.serialize_field_ownership();

insert into platform.schema_migrations (version, name, checksum)
values (53, 'field_ownership_serialization', '2c0dc88805c9d96c9ba133542ca4a31b8e8a0422f061250c14e92b5e513f2269')
on conflict (version) do nothing;

-- ============================ migration 54: agent_update_controls ============================

create table if not exists platform.agent_update_controls (
  workspace_id text not null check (char_length(workspace_id) between 1 and 128),
  kind text not null check (kind in ('runner','machine')),
  agent_id text not null check (char_length(agent_id) between 1 and 128),
  revision integer not null check (revision > 0),
  hold boolean not null,
  manifest_sha256 text check (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  requested_by text not null check (char_length(requested_by) between 1 and 128),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, kind, agent_id),
  check (not hold or manifest_sha256 is null)
);

alter table platform.agent_update_controls enable row level security;
revoke all on table platform.agent_update_controls from public;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.agent_update_controls from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant select,insert,update,delete on table platform.agent_update_controls to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (54, 'agent_update_controls', 'cbb2c080c4e5e5c3f09b4d999571d7bec54e121cb1f85b43fac407563ed189de')
on conflict (version) do nothing;

-- ============================ migration 55: isolation_custody ============================

create table if not exists platform.isolation_plan_custody (
  workspace_id text not null,
  operation_id text not null,
  plan_digest text not null check (plan_digest ~ '^[a-f0-9]{64}$'),
  artifact_digest text not null check (artifact_digest ~ '^[a-f0-9]{64}$'),
  iv text not null,
  auth_tag text not null,
  ciphertext text not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, operation_id, plan_digest),
  foreign key (workspace_id, operation_id) references platform.operations(workspace_id, id)
);
create or replace function platform.isolation_custody_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'Isolation plan custody is write-once' using errcode = '23514';
end
$$;
drop trigger if exists isolation_custody_immutable on platform.isolation_plan_custody;
create trigger isolation_custody_immutable before update or delete on platform.isolation_plan_custody
for each row execute function platform.isolation_custody_immutable();
alter table platform.isolation_plan_custody enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.isolation_plan_custody from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant select,insert on table platform.isolation_plan_custody to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (55, 'isolation_custody', 'b6e75e8ca5e06d8147f7b34086008551858f2bdf642cfc97f493d6ac9b902192')
on conflict (version) do nothing;

-- ============================ migration 56: workspace_mfa_controls ============================

create table if not exists platform.workspace_mfa_controls (
  workspace_id text primary key,
  require_for_all_mutations boolean not null default false,
  max_age_seconds integer check (max_age_seconds between 60 and 86400),
  version integer not null default 1 check (version >= 1),
  updated_by text not null,
  updated_at timestamptz not null default clock_timestamp()
);
alter table platform.workspace_mfa_controls enable row level security;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on table platform.workspace_mfa_controls from %I',r);
    end if;
  end loop;
  if exists(select 1 from pg_roles where rolname='service_role') then
    revoke all on table platform.workspace_mfa_controls from service_role;
    grant select,insert,update on table platform.workspace_mfa_controls to service_role;
  end if;
end
$$;

insert into platform.schema_migrations (version, name, checksum)
values (56, 'workspace_mfa_controls', 'aad9739d5412fe15b5ecd065a80dd205e74818287861c8484c68de578ecef3b0')
on conflict (version) do nothing;

-- ============================ migration 57: wave5_gaps ============================

alter table platform.slo_measurements drop constraint if exists slo_measurements_kind_check;
alter table platform.slo_measurements add constraint slo_measurements_kind_check
  check (kind in ('rpo','rto','capacity','database_restore','application_health'));
alter table platform.slo_measurements drop constraint if exists slo_measurements_check;
alter table platform.slo_measurements add constraint slo_measurements_check
  check ((kind in ('rpo','rto','database_restore','application_health') and unit = 'seconds') or (kind = 'capacity' and unit = 'requests_per_second'));
alter table platform.retention_restores add column if not exists key_purpose text
  check (key_purpose is null or key_purpose in ('enc:archive','enc:backup'));
alter table platform.retention_restores add column if not exists restore_key_id text
  check (restore_key_id is null or char_length(restore_key_id) between 1 and 128);
alter table platform.retention_restores add column if not exists legacy_reason text
  check (legacy_reason is null or legacy_reason ~ '^[A-Za-z0-9 ._:/()-]{1,200}$');

insert into platform.schema_migrations (version, name, checksum)
values (57, 'wave5_gaps', '55b72ecf1af8739036f17f1cd7f77b7e13f6de0e1de76773dd110af12aa8e450')
on conflict (version) do nothing;

-- ============================ migration 58: kubernetes_source_provider ============================

do $$
declare
  c record;
  widened text;
  found boolean := false;
begin
  for c in
    select conname, pg_get_constraintdef(oid) as def
      from pg_constraint
     where conrelid = 'platform.approved_source_snapshots'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) like '%''azure''::text%'
       and pg_get_constraintdef(oid) like '%tar.gz%'
  loop
    found := true;
    if c.def like '%''kubernetes''::text%' then
      continue;
    end if;
    widened := replace(c.def, '''zenith''::text]', '''zenith''::text, ''kubernetes''::text]');
    if widened = c.def then
      raise exception 'approved_source_snapshots provider constraint has an unexpected shape';
    end if;
    execute format('alter table platform.approved_source_snapshots drop constraint %I', c.conname);
    execute format('alter table platform.approved_source_snapshots add constraint %I %s', c.conname, widened);
  end loop;
  if not found then
    raise exception 'approved_source_snapshots provider constraint was not found';
  end if;
end $$;

insert into platform.schema_migrations (version, name, checksum)
values (58, 'kubernetes_source_provider', 'afef954e9417c33a3a0dadc254253ab523c9dbc425af27da5120927e8064df9a')
on conflict (version) do nothing;

-- ============================ migration 59: field_ownership_grant_revocation ============================

create or replace function platform.revoke_grants_on_ownership_change() returns trigger
language plpgsql set search_path=pg_catalog as $$
declare
  autoscalers constant text[] := array['k8s:HorizontalPodAutoscaler','aws:appautoscaling_target'];
  writes constant text[] := array['service.scale','deployment.deploy','deployment.rollback'];
  ws text;
  envs text[];
  revoked_capabilities text[];
  own_operation text;
begin
  if TG_TABLE_NAME='resources' then
    if TG_OP='INSERT' then
      if not (new.native_type=any(autoscalers) or new.spec ? 'autoscaling') then return null; end if;
    elsif TG_OP='DELETE' then
      if not (old.native_type=any(autoscalers) or old.spec ? 'autoscaling') then return null; end if;
    else
      if not (old.native_type=any(autoscalers) or old.spec ? 'autoscaling' or new.native_type=any(autoscalers) or new.spec ? 'autoscaling') then
        return null;
      end if;
      -- Unchanged facts: same place, same type, same autoscaling block, and an autoscaler node's spec unchanged.
      if new.environment_id is not distinct from old.environment_id and new.address is not distinct from old.address
         and new.native_type is not distinct from old.native_type
         and (new.spec->'autoscaling') is not distinct from (old.spec->'autoscaling')
         and (not (new.native_type=any(autoscalers)) or new.spec is not distinct from old.spec) then
        return null;
      end if;
    end if;
    revoked_capabilities := array['service.scale','drift.repair'];
  else
    revoked_capabilities := writes;
    if TG_OP='DELETE' then own_operation := old.operation_id; else own_operation := new.operation_id; end if;
  end if;
  if TG_OP='DELETE' then
    ws := old.workspace_id; envs := array[old.environment_id];
  elsif TG_OP='INSERT' then
    ws := new.workspace_id; envs := array[new.environment_id];
  else
    ws := new.workspace_id; envs := array_remove(array[old.environment_id, new.environment_id], null);
  end if;
  update platform.capability_grants g set revoked_at=clock_timestamp()
    from platform.operations o
   where g.workspace_id=ws and g.revoked_at is null and g.consumed_at is null and g.expires_at>clock_timestamp()
     and g.capability=any(revoked_capabilities)
     and o.workspace_id=g.workspace_id and o.id=g.operation_id and o.environment_id=any(envs)
     and (own_operation is null or o.id<>own_operation);
  return null;
end
$$;
create or replace trigger field_ownership_resource_grant_revocation
after insert or delete or update of environment_id,address,kind,native_type,spec on platform.resources
for each row execute function platform.revoke_grants_on_ownership_change();
create or replace trigger field_ownership_transfer_grant_revocation
after insert or update or delete on platform.ownership_transfers
for each row execute function platform.revoke_grants_on_ownership_change();

insert into platform.schema_migrations (version, name, checksum)
values (59, 'field_ownership_grant_revocation', '65049a39d46229bd9fefe1eeaa2e496c6771c2bd85957e95bafacaf09ec8ca05')
on conflict (version) do nothing;

-- ============================ hardening (Supabase roles) ============================

do $$
declare
  t record;
  r text;
begin
  for t in select tablename from pg_tables where schemaname = 'platform' loop
    execute format('alter table platform.%I enable row level security', t.tablename);
  end loop;

  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema platform from %I', r);
      execute format('revoke all on all tables in schema platform from %I', r);
      execute format('revoke all on all sequences in schema platform from %I', r);
    end if;
  end loop;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema platform to service_role;
    grant select, insert, update, delete on all tables in schema platform to service_role;
    grant usage, select, update on all sequences in schema platform to service_role;
    alter default privileges in schema platform grant select, insert, update, delete on tables to service_role;
    alter default privileges in schema platform grant usage, select, update on sequences to service_role;
    -- Direct-object custody is immutable and must not inherit aggregate DML.
    if to_regclass('platform.isolation_plan_custody') is not null then
      revoke all on table platform.isolation_plan_custody from service_role;
      grant select, insert on table platform.isolation_plan_custody to service_role;
    end if;
    if to_regclass('platform.workspace_mfa_controls') is not null then
      revoke all on table platform.workspace_mfa_controls from service_role;
      grant select, insert, update on table platform.workspace_mfa_controls to service_role;
    end if;
    -- Permanent agent receipts keep their narrower migration-specific grants.
    -- Guard absence for the exact legacy schema6 upgrade fixture.
    if to_regclass('platform.agent_effect_receipts') is not null then
      revoke update, delete on table platform.agent_effect_receipts from service_role;
    end if;
    -- Workflow-start attempt tombstones must survive aggregate hardening.
    -- Exact rights also remove inherited TRUNCATE, REFERENCES and TRIGGER.
    if to_regclass('platform.workflow_start_intents') is not null then
      revoke all on table platform.workflow_start_intents from service_role;
      grant select, insert, update on table platform.workflow_start_intents to service_role;
    end if;
    -- Approved source authority is immutable, including inherited privileges.
    if to_regclass('platform.approved_source_snapshots') is not null then
      revoke all on table platform.approved_source_snapshots from service_role;
      grant select, insert on table platform.approved_source_snapshots to service_role;
    end if;
    -- Mixed child candidates never inherit DELETE/TRUNCATE or writable descriptor grants.
    if to_regclass('platform.mixed_child_custody') is not null then
      revoke all on table platform.mixed_child_custody from service_role;
      grant select, insert on table platform.mixed_child_custody to service_role;
    end if;
    if to_regclass('platform.mixed_child_intents') is not null then
      revoke all on table platform.mixed_child_intents from service_role;
      grant select, insert, update on table platform.mixed_child_intents to service_role;
    end if;
    if to_regclass('platform.cleanup_writer_epoch') is not null then
      revoke all on table platform.cleanup_writer_epoch,platform.cleanup_writer_scopes,platform.cleanup_writer_holds,platform.cleanup_writer_deliveries,platform.cleanup_owner_grants from service_role;
      grant select on table platform.cleanup_writer_epoch to service_role;
      grant select,insert on table platform.cleanup_writer_scopes,platform.cleanup_writer_holds,platform.cleanup_writer_deliveries,platform.cleanup_owner_grants to service_role;
      grant update on table platform.cleanup_writer_scopes to service_role;
    end if;
    -- Ownership transfers are append-only: select/insert plus one-way revocation columns.
    if to_regclass('platform.ownership_transfers') is not null then
      revoke all on table platform.ownership_transfers from service_role;
      grant select, insert on table platform.ownership_transfers to service_role;
      grant update (revoked_at, revoked_by) on table platform.ownership_transfers to service_role;
    end if;
    if to_regclass('platform.optimizer_settings') is not null then
      revoke all on table platform.optimizer_settings from service_role;
      grant select,insert,update on table platform.optimizer_settings to service_role;
    end if;
    if to_regclass('platform.standalone_plan_settlements') is not null then
      revoke all on table platform.standalone_plan_backends,platform.standalone_plan_settlements from service_role;
      grant select,insert on table platform.standalone_plan_backends,platform.standalone_plan_settlements to service_role;
    end if;
    if to_regclass('platform.machine_runbook_versions') is not null then
      revoke all on table platform.machine_runbook_versions,platform.machine_runbook_approvals,platform.machine_runbook_audit,platform.machine_runbook_schedules,platform.machine_runbook_runs,platform.machine_runbook_run_steps from service_role;
      grant select,insert on table platform.machine_runbook_versions,platform.machine_runbook_approvals,platform.machine_runbook_audit to service_role;
      grant select,insert,update on table platform.machine_runbook_schedules,platform.machine_runbook_runs,platform.machine_runbook_run_steps to service_role;
    end if;
    -- Platform schemas 30 to 36 (wave 3) keep the narrower grants their own migrations set.
    if to_regclass('platform.operation_authority') is not null then
      revoke all on table platform.operation_authority,platform.durable_intents from service_role;
      grant select on table platform.operation_authority to service_role;
      grant select,insert,update on table platform.durable_intents to service_role;
    end if;
    if to_regclass('platform.approved_semantics') is not null then
      revoke all on table platform.approved_semantics,platform.standing_grants,platform.standing_grant_uses from service_role;
      grant select,insert on table platform.approved_semantics to service_role;
      grant select,insert,update on table platform.standing_grants,platform.standing_grant_uses to service_role;
    end if;
    if to_regclass('platform.external_effects') is not null then
      revoke all on table platform.external_effects,platform.external_effect_events,platform.external_effect_resolutions from service_role;
      grant select,insert,update on table platform.external_effects to service_role;
      grant select,insert on table platform.external_effect_events,platform.external_effect_resolutions to service_role;
    end if;
    if to_regclass('platform.k8s_guest_bindings') is not null then
      revoke all on table platform.k8s_guest_bindings from service_role;
      grant select,insert,update on table platform.k8s_guest_bindings to service_role;
    end if;
    if to_regclass('platform.coding_agent_runs') is not null then
      revoke all on table platform.coding_agent_runs from service_role;
      grant select,insert,update on table platform.coding_agent_runs to service_role;
    end if;
    -- Platform schemas 37 to 41 (wave 4) keep the narrower grants their own migrations set.
    if to_regclass('platform.actual_spend_snapshots') is not null then
      revoke all on table platform.actual_spend_snapshots from service_role;
      grant select,insert on table platform.actual_spend_snapshots to service_role;
    end if;
    if to_regclass('platform.ops_maintenance') is not null then
      revoke all on table platform.ops_maintenance,platform.ops_maintenance_history,platform.tenant_quotas from service_role;
      grant select,insert,update on table platform.ops_maintenance to service_role;
      grant select,insert on table platform.ops_maintenance_history to service_role;
      grant select,insert,update,delete on table platform.tenant_quotas to service_role;
    end if;
    if to_regclass('platform.key_custody_keys') is not null then
      revoke all on table platform.key_custody_keys,platform.key_rewrap_jobs from service_role;
      grant select,insert,update on table platform.key_custody_keys,platform.key_rewrap_jobs to service_role;
    end if;
    if to_regclass('platform.mixed_parent_plans') is not null then
      revoke all on table platform.mixed_parent_plans,platform.mixed_child_plans,platform.mixed_child_receipts,platform.mixed_addresses from service_role;
      grant select,insert,update on table platform.mixed_parent_plans,platform.mixed_child_plans to service_role;
      grant select,insert on table platform.mixed_child_receipts,platform.mixed_addresses to service_role;
    end if;
    if to_regclass('platform.mixed_runs') is not null then
      revoke all on table platform.mixed_runs,platform.mixed_run_events,platform.mixed_output_preauthorizations from service_role;
      grant select,insert,update on table platform.mixed_runs,platform.mixed_output_preauthorizations to service_role;
      grant select,insert on table platform.mixed_run_events to service_role;
    end if;
    -- Wave 5 (44 to 52): aggregate grants must preserve every immutable ledger.
    if to_regclass('platform.mixed_output_records') is not null then
      revoke all on table platform.mixed_output_records from service_role;
      grant select,insert on table platform.mixed_output_records to service_role;
    end if;
    if to_regclass('platform.slo_measurements') is not null then
      revoke all on table platform.slo_measurements from service_role;
      grant select,insert on table platform.slo_measurements to service_role;
    end if;
    if to_regclass('platform.recovery_epochs') is not null then
      revoke all on table platform.recovery_epochs,platform.recovery_items from service_role;
      grant select,insert on table platform.recovery_epochs to service_role;
      grant select,insert,update on table platform.recovery_items to service_role;
    end if;
    if to_regclass('platform.legal_holds') is not null then
      revoke all on table platform.legal_holds,platform.retention_archives,platform.retention_destinations,platform.retention_restores from service_role;
      grant select,insert,update on table platform.legal_holds,platform.retention_archives,platform.retention_destinations to service_role;
      grant select,insert on table platform.retention_restores to service_role;
    end if;
    if to_regclass('platform.audit_exports') is not null then
      revoke all on table platform.audit_exports from service_role;
      grant select,insert on table platform.audit_exports to service_role;
    end if;
    if to_regclass('platform.managed_domains') is not null then
      revoke all on table platform.managed_domains,platform.managed_storage_keys from service_role;
      grant select,insert,update on table platform.managed_domains,platform.managed_storage_keys to service_role;
    end if;
    if to_regclass('platform.billing_accounts') is not null then
      revoke all on table platform.billing_accounts,platform.billing_account_events,platform.billing_invoices,platform.billing_usage_events,platform.billing_webhook_events from service_role;
      grant select,insert,update on table platform.billing_accounts,platform.billing_invoices,platform.billing_usage_events,platform.billing_webhook_events to service_role;
      grant select,insert on table platform.billing_account_events to service_role;
    end if;
  end if;
end
$$;
