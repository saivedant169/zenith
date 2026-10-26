/**
 * Encrypted, off-host backup and clean-host restore.
 *
 *   targets.ts  where bytes go: a directory or an S3-compatible bucket
 *   crypto.ts   AES-256-GCM under ZENITH_BACKUP_KEY, and the key-id label
 *   bundle.ts   the ZBK1 container: a manifest and length-prefixed files
 *   create.ts   the WAL-safe snapshot of the authority and every app database
 *   restore.ts  clean-directory restore with revocation reconciliation
 *   reopen.ts   the deliberate second step, with real checks
 *
 * The one import for consumers: `@/lib/hosted/backup`.
 */
export {
  FilesystemTarget,
  REVOCATION_LEDGER_KEY,
  S3Target,
  backupKeyFor,
  backupS3Region,
  requireBackupTarget,
  selectedBackupTarget,
  type BackupTargetSelection,
  type S3Like,
  type S3TargetOptions,
} from "./targets";
export {
  BACKUP_KEY_FIX,
  backupKey,
  backupKeyConfigured,
  keyIdOf,
  seal,
  sealedKeyId,
  unseal,
} from "./crypto";
export {
  packBundle,
  sha256,
  unpackBundle,
  type BundleFile,
  type DraftManifest,
  type UnpackedBundle,
} from "./bundle";
export { createBackup, snapshotSqlite, type ArtifactInventory, type CreateBackupOptions } from "./create";
export {
  RESTORE_REPORT_FILE,
  restoreBackup,
  type ReconciliationReport,
  type RestoreOptions,
  type RestoreReport,
} from "./restore";
export { reopenApp, type ReopenCheck, type ReopenOptions, type ReopenResult } from "./reopen";
