# Key custody: purposes, rotation, decrypt-only histories

Written against branch `codex/production-2026-10-02`, guide input at `af5d60b4c2f47d549fe352d78d19b3a0c6101d6e`. Source documentation only; deployment and recovery acceptance remain separately recorded.

PROD-OPS-05. Every key the control plane holds or trusts has one purpose. The key registry
(`src/lib/keycustody`) refuses to use a key outside its purpose or role, keeps retired keys
decrypt-only or verify-only, and gives operators diagnostics that print ids, purposes, roles and ages
but never key material.

This is not a KMS. Symmetric keys still arrive through environment variables (or files your secret
manager mounts); the registry adds separation, refusal, overlap and visibility on top. The release
signing key is offline by design and the control plane never holds it. KMS-backed signing keys expose
no material at all.

## Purposes

| Purpose | Operations | Source | Current / historical |
| --- | --- | --- | --- |
| `enc:vault` | encrypt, decrypt | `ZENITH_SECRET_KEY` | `ZENITH_VAULT_PREVIOUS_SECRET_KEYS` (decrypt-only) |
| `enc:results` | encrypt, decrypt | `ZENITH_RUNNER_RESULT_KEY`, else derived from the control signing key (warning) | `ZENITH_RUNNER_RESULT_PREVIOUS_KEYS` (decrypt-only); the legacy derivation is kept decrypt-only automatically once an explicit key is set |
| `enc:machine-results` | encrypt, decrypt | HKDF domain of `ZENITH_SECRET_KEY` | previous vault keys, derived the same way |
| `enc:temporal-payload` | encrypt, decrypt | `ZENITH_TEMPORAL_PAYLOAD_KEY`, else HKDF domain of `ZENITH_SECRET_KEY` | `ZENITH_TEMPORAL_PREVIOUS_SECRET_KEYS` (decrypt-only) |
| `enc:plan-artifacts` | encrypt, decrypt | `ZENITH_PLAN_ARTIFACT_KEY` | `ZENITH_PLAN_ARTIFACT_PREVIOUS_KEYS` (plan custody owns its rewrap) |
| `enc:archive` | encrypt, decrypt | distinct archive HKDF domain of `ZENITH_BACKUP_KEY` | explicit legacy restore key only; no backup-purpose fallback |
| `enc:backup` | encrypt, decrypt | `ZENITH_BACKUP_KEY` | none in this build (backups carry their key id) |
| `signing:jobs` | sign, verify | `ZENITH_CONTROL_SIGNING_JWK` or `ZENITH_CONTROL_KMS_KEY_ID` | `ZENITH_CONTROL_EXTRA_PUBLIC_JWKS` (verify-only) |
| `signing:audit-export` | sign, verify | independent local `ZENITH_AUDIT_EXPORT_SIGNING_JWK` | no control/OIDC/release key reuse or KMS fallback |
| `signing:oidc` | sign, verify | `ZENITH_OIDC_SIGNING_JWK` or `ZENITH_OIDC_KMS_KEY_ID` | `ZENITH_OIDC_EXTRA_PUBLIC_JWKS` (verify-only) |
| `signing:release` | verify | none on the control plane (offline key; agents pin public keys) | a private key present here is an error |
| `signing:plugin-publisher` | verify | `ZENITH_PLUGIN_TRUSTED_PUBLISHERS` | all keys are verify-only public keys |
| `signing:template-attestation` | verify | `ZENITH_E2B_TEMPLATE_ATTESTATION_PUBLIC_KEY` | verify-only |
| `tls:temporal-mtls` | verify | `ZENITH_TEMPORAL_TLS_*` files | reported by certificate fingerprint and expiry only |

A role limits what a key may do: only the current key encrypts or signs; a decrypt-only key only
decrypts; a verify-only key only verifies. Asking the registry for anything else raises a fixed
`key_purpose_operation`, `key_role_operation` or `key_unavailable` refusal.

### Separation findings

`scripts/key-custody.ts diagnose` and the worker start-up check report:

- **error** `key_reused_across_purposes`: two purposes share key material (the worker refuses to start);
- **error** `release_private_key_online`: `ZENITH_RELEASE_KEY_FILE` is present on the control plane (the worker refuses to start);
- **error** `signing_key_reused`, `key_config_invalid`;
- **warning** `result_key_derived_from_signing_key`: set `ZENITH_RUNNER_RESULT_KEY` so signing and encryption keys rotate independently;
- **notice** `purpose_shares_root_with_vault`: Temporal payloads and machine results are HKDF domains of `ZENITH_SECRET_KEY`. They are domain-separated, but rotating the vault key rotates them too. Set `ZENITH_TEMPORAL_PAYLOAD_KEY` to give Temporal its own root.

## Where each key is used today (audit)

| Key | Used by | Rotation story | Known limit |
| --- | --- | --- | --- |
| `ZENITH_SECRET_KEY` | vault values; agent-link secrets (`seal()`); hosted invite payloads; HKDF root for machine results, Temporal (unless dedicated) and plan fingerprints | vault: previous list plus durable rewrap | agent-link and invite sealing use the key directly with no decrypt-only overlap: a rotation fails outstanding link codes and undelivered invites closed (both are short-lived) |
| `ZENITH_RUNNER_RESULT_KEY` | runner and zenithd result bodies at rest, effect receipts | previous list; boxes carry a key id | the immutable effect receipts keep their sealed copy; dropping a key makes receipts sealed under it unreadable |
| `ZENITH_CONTROL_SIGNING_JWK` | grants, runner jobs, machine requests, signed runbooks | extra public JWKS overlap | a local JWK is in process memory; prefer KMS |
| `ZENITH_PLAN_ARTIFACT_KEY` | raw plan custody | previous list | rewrap of plan rows belongs to plan custody (DUR-C) |
| `ZENITH_BACKUP_KEY` | hosted backups | key id in the container header | no decrypt-only list yet |
| plugin publisher keys | plugin manifest provenance | add the new key id, re-register, remove the old | verify-only |
| release keys | agent self-update manifests | sign with a new offline key; agents pin both until updated | offline; not on the control plane |

## Rotation

1. Configure the new key as current and move the old key into the purpose's previous list. A self-hosted installation does this for every generated key with `node scripts/deploy/installation.mjs rotate <installation>` (it also gives Temporal and results their own roots); then recreate the API and worker together. Roll it to every process that reads the purpose (web, worker, scheduler): for Temporal and results this must reach clients and workers together.
2. `scripts/key-custody.ts sync` records the key ids and their first-seen time (the key's age).
3. Vault only: `scripts/key-custody.ts rewrap --workspace <id>` queues a durable re-wrap. The `key-rewrap` critical job (on the Temporal critical-maintenance schedule, with the cron fallback) works it in bounded batches under write locks with a durable cursor; a restart resumes. `rewrap-status` shows progress. A row that opens under no retained key fails the job with `unreadable_row` and writes nothing in that batch. The file store is `blocked`: run `scripts/vault-rewrap.ts` quiesced instead.
4. Schedule retirement: `scripts/key-custody.ts retire-after --purpose enc:vault --key-id <id> --date <ISO>`. The diagnostic and the job's health counts report `overdue` (past its date and still configured) and `unscheduled` historical keys.
5. After the history that needs the old key is gone (rewrap complete; no open or replayable Temporal history; results window passed) remove it from the previous list, then record `scripts/key-custody.ts retire --purpose ... --key-id ... --by <name>`.

Temporal history is immutable: it cannot be re-wrapped, only kept readable. `scripts/key-custody.ts codec --file history.json [--verify]` reads a `temporal workflow show --output json` document and reports which key id each payload needs, whether that key is current, decrypt-only or missing, and (with `--verify`) whether it decrypts, without printing any payload.

## Diagnostics

`scripts/key-custody.ts diagnose [--json] [--no-db]` prints per purpose the current key id, the historical keys, their roles, ages, retirement state, certificate expiry for Temporal mTLS and the separation findings. Exit 1 on an error-level finding. Without a Postgres platform store it still reports ids and roles but cannot report ages. Output contains ids, purposes, roles, variable names, counts and certificate fingerprints, and nothing else.

## Limits

- Key ids are HMACs of the material under a purpose label; they are non-secret but identify a key to anyone who also holds it. Temporal payload ids are the ones already written into every payload.
- Ages come from the first time a process recorded the key (`sync` or the `key-rewrap` job), not from when the key was generated.
- This build does not hold keys in an HSM, does not enforce rotation deadlines by itself, and makes no live Temporal Cloud or KMS acceptance claim.
