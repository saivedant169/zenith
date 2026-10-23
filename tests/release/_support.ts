/** Shared helpers for the release-governance tests (PROD-REL-01/02/04). No cloud, no network. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { Scope, contentDigest, parseManifest, type ScopeManifest } from "../../scripts/release/scope";

export const RUN = "zlive-202610071200-abcd";
export const NOW = new Date("2026-10-08T00:00:00.000Z");

export const shippedManifestPath = (): string => path.resolve("docs/build/production/permissions.json");
export const shippedRaw = (): Record<string, unknown> => JSON.parse(readFileSync(shippedManifestPath(), "utf8")) as Record<string, unknown>;

/** Test identities for every cloud sandbox (the shipped manifest leaves them null until the owner confirms real ones). */
export function confirmSandboxes(raw: Record<string, unknown>): void {
  raw.sandboxes = {
    aws: { accountId: "123456789012", regions: ["us-east-1"] },
    gcp: { projectId: "zenith-test-project", regions: ["us-central1"] },
    azure: { subscriptionId: "00000000-0000-4000-8000-000000000001", tenantId: "00000000-0000-4000-8000-000000000002", regions: ["eastus"] },
    oci: { tenancyId: "ocid1.tenancy.oc1..test", compartmentId: "ocid1.compartment.oc1..test", regions: ["us-ashburn-1"] },
    supabase: { projectRef: "abcdefghijklmnopqrst", region: "us-east-1" },
  };
}

/** The shipped manifest as a person would have approved it at `NOW` (with confirmed test sandboxes), optionally edited BEFORE the approval is pinned. */
export function approvedManifest(edit?: (raw: Record<string, unknown>) => void): ScopeManifest {
  const raw = shippedRaw();
  confirmSandboxes(raw);
  edit?.(raw);
  const unapproved = parseManifest(raw);
  return parseManifest({
    ...unapproved,
    approval: { status: "approved", approvedBy: "Test Person", approvedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 86_400_000).toISOString(), approvedDigest: contentDigest(unapproved) },
  });
}

export const approvedScope = (edit?: (raw: Record<string, unknown>) => void, now: Date = NOW): Scope => new Scope(approvedManifest(edit), () => now);
