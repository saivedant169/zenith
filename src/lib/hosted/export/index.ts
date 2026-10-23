/**
 * App export and import — the "you can leave" file (G21, G27).
 *
 * **What an export is.** One JSON document holding the app record, its release
 * history, the file table of the artifact it is serving, its access manifest
 * and every equipment request in it. It is a customer's own data in a shape
 * another install of this product can read back, and a shape a person can read
 * with `jq`.
 *
 * **What an export is not, and says so in `limitations`.** It does not carry
 * the app's *source* — the platform builds from a pinned recipe and stores the
 * built artifact, so what an export can honestly list is the artifact's file
 * table, not the code that produced it. It does not carry artifact bytes. It
 * does not carry sessions, invitation tokens or anything else that would let
 * the file itself grant access to anybody.
 *
 * **What an import restores: data, and access *intent*.** Records come back
 * with their original ids, versions and timestamps, so history is preserved
 * rather than re-created. Access does not: a grant is bound to a subject
 * issued by an identity provider, and those subjects do not travel between
 * installs. Every person on the imported access manifest therefore arrives as
 * a `needs_reapproval` grant with a placeholder subject that can never match a
 * real caller. An owner has to re-grant each of them to a real identity.
 * "Everyone who had access has access again" is exactly the claim this refuses
 * to make.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  EquipmentRequestInput,
  HostedError,
  TRACKER_LIMITS,
  type AppGrant,
  type AppInvite,
  type AppRole,
  type ArtifactFile,
  type ArtifactStore,
  type DataContext,
  type EquipmentRequest,
  type GrantState,
  type HostedApp,
  type InviteState,
  type Release,
  type Subject,
} from "@/lib/hosted/contracts";
import { authority } from "@/lib/hosted/authority";
import { FsArtifactStore } from "@/lib/hosted/artifacts";
import { openAppData } from "@/lib/hosted/data";
import { INSTALL_WORKSPACE, recordEvent } from "@/lib/hosted/events";

/** The format tag every bundle carries, so a reader can refuse a future one. */
export const EXPORT_FORMAT = "zenith-app-export/1" as const;

/** How many records one export will page through before it refuses to go on. */
export const EXPORT_RECORD_CEILING = 100_000;

/* --------------------------------- shapes --------------------------------- */

/** One person on the access manifest. Emails, roles and states — never a subject. */
export interface ExportedGrant {
  email: string;
  role: AppRole;
  state: GrantState;
  createdAt: string;
}

/** One outstanding invitation, without its token. */
export interface ExportedInvite {
  email: string;
  role: AppRole;
  state: InviteState;
  createdAt: string;
  expiresAt: string;
}

/** The whole export. */
export interface AppExport {
  format: typeof EXPORT_FORMAT;
  exportedAt: string;
  app: HostedApp;
  schemaVersion: number;
  releases: Release[];
  activeRelease: Release | null;
  /** The active release's artifact: its digest and the files it serves. Never the bytes. */
  artifact: { digest: string; files: ArtifactFile[] } | null;
  access: { grants: ExportedGrant[]; invites: ExportedInvite[] };
  records: EquipmentRequest[];
  /** What can honestly be said about the source. Never the source itself. */
  source: { included: false; reason: string; artifactFiles: string[] };
  limitations: string[];
}

/** How an export is taken. */
export interface ExportAppOptions {
  /** Who asked. Recorded on the event, never in the file. */
  subject?: Subject;
  email?: string;
  /** Refuse past this many records rather than build an unbounded document. */
  maxRecords?: number;
  /** Injected in tests; production uses the configured store. */
  artifacts?: ArtifactStore;
}

/* --------------------------------- export --------------------------------- */

/**
 * Build the export for one app.
 *
 * Records are paged through the store with its own keyset cursor — every page,
 * until there is no next cursor — so an app with more than one page exports
 * all of it and an app being written to during the export does not cause a row
 * to be skipped or repeated.
 */
export async function exportApp(appId: string, options: ExportAppOptions = {}): Promise<AppExport> {
  const a = authority();
  const app = await a.repos.apps.get(appId);
  if (!app)
    throw new HostedError("not_found", `No hosted app has the id ${appId}.`, {
      fix: "Open the app from the apps list and export it from there; the id in the URL is the one this endpoint takes.",
    });

  const releases = await a.repos.releases.listByApp(appId, { limit: 1000 });
  const activeRelease = app.activeReleaseId ? ((await a.repos.releases.get(app.activeReleaseId)) ?? null) : null;

  let artifact: AppExport["artifact"] = null;
  if (activeRelease) {
    const store = options.artifacts ?? new FsArtifactStore();
    const files = await store.list(activeRelease.artifactDigest);
    artifact = { digest: activeRelease.artifactDigest, files };
  }

  const data = openAppData(appId);
  const ctx: DataContext = {
    appId,
    subject: options.subject ?? "export",
    email: options.email ?? "export@zenith.local",
    role: "owner",
    releaseId: activeRelease?.id ?? "export",
  };

  const ceiling = Math.min(options.maxRecords ?? EXPORT_RECORD_CEILING, EXPORT_RECORD_CEILING);
  const records: EquipmentRequest[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await data.store.list(ctx, { limit: TRACKER_LIMITS.listMax, cursor });
    records.push(...page.items);
    if (records.length > ceiling)
      throw new HostedError(
        "invalid_input",
        `This app holds more than ${ceiling} requests, which is more than one export document should carry.`,
        {
          fix: "Ask Zenith for a streamed export. A JSON document this size is not something a browser or a person can work with.",
          details: { ceiling },
        }
      );
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  const exported: AppExport = {
    format: EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    app,
    schemaVersion: await data.store.schemaVersion(appId),
    releases,
    activeRelease,
    artifact,
    access: {
      grants: (await a.repos.grants.listByApp(appId)).map(toExportedGrant),
      invites: (await a.repos.invites.listByApp(appId)).map(toExportedInvite),
    },
    records,
    source: {
      included: false,
      reason:
        "Zenith builds from a pinned recipe and stores the built artifact, not the submitted source, so an export can list what the app serves but cannot hand back the code that produced it.",
      artifactFiles: (artifact?.files ?? []).map((file) => file.path),
    },
    limitations: [
      "Access is an intent, not a transfer: grants are bound to identity-provider subjects, which do not travel between installs. An import recreates every person as a grant held for re-approval.",
      "No session, invitation token or exchange code is in this file. It cannot be replayed to open the app.",
      "This file is not anonymous. The access manifest carries emails, and every record carries the identity-provider subject and email of whoever created and last updated it — that authorship is part of the frozen record contract, and stripping it would make the export a different document from the data. Treat the file as customer data.",
      "Artifact bytes are not included — only the digest and the file table. The artifact store is content-addressed and is copied separately.",
      "Records are a point-in-time read. Writes made while the export was being paged may land after the last page it read.",
    ],
  };

  await recordEvent({
    event: "export.completed",
    workspaceId: app.workspaceId,
    appId,
    subject: options.subject,
    email: options.email,
    logicalId: `export:${appId}:${exported.exportedAt}`,
    props: { records: records.length, releases: releases.length, grants: exported.access.grants.length },
  });
  return exported;
}

const toExportedGrant = (grant: AppGrant): ExportedGrant => ({
  email: grant.email,
  role: grant.role,
  state: grant.state,
  createdAt: grant.createdAt,
});

const toExportedInvite = (invite: AppInvite): ExportedInvite => ({
  email: invite.email,
  role: invite.role,
  state: invite.state,
  createdAt: invite.createdAt,
  expiresAt: invite.expiresAt,
});

/* --------------------------------- import --------------------------------- */

const Role = z.enum(["owner", "editor", "viewer"]);

/**
 * A record as it is read back in. The contract's own input schema plus the
 * server-assigned fields, so an imported row is validated exactly as hard as a
 * row written through the broker — an import is not a way around the contract.
 */
const ImportedRecord = EquipmentRequestInput.extend({
  id: z.string().min(1).max(200),
  version: z.number().int().min(1),
  createdBy: z.string().min(1).max(200),
  createdByEmail: z.string().min(1).max(320),
  createdAt: z.string().min(1).max(40),
  updatedBy: z.string().min(1).max(200),
  updatedByEmail: z.string().min(1).max(320),
  updatedAt: z.string().min(1).max(40),
});

const ImportBundle = z.object({
  format: z.literal(EXPORT_FORMAT),
  exportedAt: z.string().optional(),
  app: z.object({ name: z.string().min(1).max(200), slug: z.string().optional() }).passthrough().optional(),
  access: z
    .object({
      grants: z.array(z.object({ email: z.string().min(3).max(320), role: Role })).prefault([]),
      invites: z.array(z.object({ email: z.string().min(3).max(320), role: Role })).prefault([]),
    })
    .prefault({ grants: [], invites: [] }),
  records: z.array(ImportedRecord).max(50_000).prefault([]),
});

/** Where an import lands. */
export interface ImportAppOptions {
  workspaceId: string;
  /** The new app's hostname label. Must be free. */
  slug: string;
  /** The subject that becomes the new app's owner. */
  createdBy: Subject;
  /** That subject's verified email, for the owner grant's display field. */
  email: string;
  /** Overrides the imported name. */
  name?: string;
}

/** What an import did, in numbers the caller can check against the file. */
export interface ImportResult {
  app: HostedApp;
  records: { imported: number; skipped: { id: string; reason: string }[] };
  access: {
    /** The importer's own owner grant. Always exactly one. */
    owner: number;
    /** Placeholder grants created from the file's grant list, held for re-approval. */
    fromGrants: number;
    /** Placeholder grants created from the file's outstanding invitations. */
    fromInvites: number;
  };
  limitations: string[];
}

/**
 * The placeholder subject an imported person is recorded under.
 *
 * Deliberately not a UUID: an identity-provider subject is a UUID, so this can
 * never be matched by a real caller, and it reads as what it is when someone
 * looks at the grants table.
 */
export const importedSubject = (origin: "grant" | "invite", email: string): string =>
  `imported-${origin}:${email.toLowerCase()}`;

/**
 * Create a new app from an export bundle.
 *
 * The app row and the owner grant are written through the control authority
 * directly — an import is not a publish, and it never asks the release
 * module for a job. Records go into the new app's own database through the
 * same quota-checked insert the broker uses, keeping their original ids,
 * versions and timestamps.
 */
export async function importApp(bundle: unknown, options: ImportAppOptions): Promise<ImportResult> {
  const parsed = ImportBundle.safeParse(bundle);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 10).map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    }));
    throw new HostedError("invalid_input", "That file is not a Zenith app export this build can read.", {
      fix: `Import a file whose "format" is "${EXPORT_FORMAT}", exactly as GET /api/hosted/apps/:appId/export produced it.`,
      details: { issues },
    });
  }
  const file = parsed.data;

  const a = authority();
  if (await a.repos.apps.getBySlug(options.slug))
    throw new HostedError("conflict", `The slug "${options.slug}" is already taken by another app on this install.`, {
      fix: "Import under a different slug — it becomes the app's hostname, so it has to be unique across the install.",
    });

  const appId = randomUUID();
  const ownerEmail = options.email.toLowerCase();
  const now = new Date().toISOString();

  const created = await a.tx(async (repos) => {
    const app = await repos.apps.insert({
      id: appId,
      workspaceId: options.workspaceId,
      slug: options.slug,
      name: options.name ?? file.app?.name ?? options.slug,
      createdBy: options.createdBy,
      runtime: "local",
      state: "active",
      createdAt: now,
    });
    await repos.grants.insert({
      id: randomUUID(),
      appId,
      subject: options.createdBy,
      email: ownerEmail,
      role: "owner",
      grantedBy: options.createdBy,
      state: "active",
      createdAt: now,
    });
    return app;
  });

  // Everyone else arrives held: their identities were issued by another
  // install's identity provider and mean nothing here.
  const seen = new Set<string>([ownerEmail]);
  let fromGrants = 0;
  let fromInvites = 0;
  await a.tx(async (repos) => {
    for (const entry of file.access.grants) {
      const email = entry.email.toLowerCase();
      if (seen.has(email)) continue;
      seen.add(email);
      await repos.grants.insert({
        id: randomUUID(),
        appId,
        subject: importedSubject("grant", email),
        email,
        role: entry.role,
        grantedBy: options.createdBy,
        state: "needs_reapproval",
        createdAt: now,
      });
      fromGrants += 1;
    }
    for (const entry of file.access.invites) {
      const email = entry.email.toLowerCase();
      if (seen.has(email)) continue;
      seen.add(email);
      await repos.grants.insert({
        id: randomUUID(),
        appId,
        subject: importedSubject("invite", email),
        email,
        role: entry.role,
        grantedBy: options.createdBy,
        state: "needs_reapproval",
        createdAt: now,
      });
      fromInvites += 1;
    }
  });

  const records = await importRecords(appId, file.records as EquipmentRequest[]);

  await recordEvent({
    event: "app.created",
    workspaceId: options.workspaceId,
    appId,
    subject: options.createdBy,
    email: options.email,
    logicalId: `import:${appId}`,
    props: {
      via: "import",
      records: records.imported,
      heldGrants: fromGrants + fromInvites,
      sourceExportedAt: file.exportedAt ?? "unknown",
    },
  });

  return {
    app: created,
    records,
    access: { owner: 1, fromGrants, fromInvites },
    limitations: [
      `${fromGrants + fromInvites} person(s) from the file are recorded as grants held for re-approval under placeholder subjects (${importedSubject("grant", "someone@example.com")}). None of them can open this app until an owner grants them to a real identity.`,
      "Outstanding invitations were not re-issued: an invitation is a single-use token bound to the install that minted it.",
      "Sessions were not imported. Everyone signs in again.",
      "No release was imported: the new app has no artifact and serves nothing until it is published here.",
    ],
  };
}

/**
 * Write imported records into the new app's database.
 *
 * The store's own quota-admitted insert is used, so the storage quota is
 * enforced on an import exactly as it is on a write, and the running byte
 * counter stays correct. A record whose id is already present is skipped and
 * reported rather than merged — an import into a fresh app should never hit
 * this, and silently choosing a winner would be the wrong answer if it did.
 *
 * The writing itself is `openAppData(appId).ops.importRecords`, which is
 * implemented on both stores; this function owns the refusal's wording, because
 * "importing this app would take it past its limit" is a fact about the import
 * and not about the database. On SQLite the whole import is one transaction and
 * a refusal rolls it back; on Postgres the bundle's total is checked against the
 * app's headroom before anything is written, and the refusal names how many
 * records were already written in the narrow case where another writer filled
 * the app mid-import.
 */
async function importRecords(appId: string, records: EquipmentRequest[]): Promise<ImportResult["records"]> {
  const data = openAppData(appId);
  const limitLogicalBytes = data.store.storageLimitBytes;

  return data.ops.importRecords(records, {
    quotaRefusal: (imported) =>
      new HostedError(
        "quota_exceeded",
        `Importing this app would take it past its ${limitLogicalBytes} logical-byte storage limit (${imported} of ${records.length} imported).`,
        {
          fix: "Ask Zenith to raise the storage limit for the destination app before importing, or import into an install configured with a larger limit.",
          details: { imported, total: records.length, limitLogicalBytes },
        }
      ),
  });
}

/** The workspace install-wide import/export events are filed under when there is no app yet. */
export { INSTALL_WORKSPACE };
