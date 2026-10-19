/**
 * `k8s:ServiceAccount` — identity.
 *
 * Rendering translates grants, but this reader observes only the account.
 * Effective RBAC/cloud access is unknown until separately inspected. A bound
 * token is enabled only for rendered RBAC (or an explicit context opt-in).
 */
import { nativeTypeFor } from "@/lib/resources/native-types";
import { PORTABLE_KINDS, type PortableKind, type ResourceNode } from "@/lib/resources/types";
import { dig, isRecord } from "../../util";
import { makeKubernetesDriver, type KindDef } from "../shared";

/**
 * Grants whose target kind has no native type on this provider (a cloud log group on Kubernetes) render no RBAC and are
 * reported as not verifiable elsewhere; they are not grants this account could hold.
 */
function kubernetesGrants(node: ResourceNode): unknown[] {
  if (!Array.isArray(node.spec.grants)) return [];
  return node.spec.grants.filter((grant) => {
    const kind = isRecord(grant) && typeof grant.target === "string" ? grant.target.split("/")[0] : "";
    return kind === "provider_native" || !(PORTABLE_KINDS as readonly string[]).includes(kind) || nativeTypeFor(node.provider, kind as PortableKind) !== undefined;
  });
}

export const serviceAccountDef: KindDef = {
  suffix: "serviceaccount",
  nativeType: "k8s:ServiceAccount",
  kind: "ServiceAccount",
  portable: ["identity"],
  attributes: (live) => ({ automountServiceAccountToken: dig(live, "automountServiceAccountToken") === true }),
  // A driver has no graph/context: it cannot know which grants rendered RBAC.
  expected: (node) => kubernetesGrants(node).length ? {} : { automountServiceAccountToken: false },
  extraChecks: (node) => kubernetesGrants(node).length ? [{
    id: "grants", description: "identity grants are effective", passed: "unknown",
    detail: "ServiceAccount observation alone does not inspect RBAC, cloud trust/federation, admission wiring or effective permissions.",
  }] : [],
  summary: (live) => ({ automountServiceAccountToken: dig(live, "automountServiceAccountToken") === true }),
  skipDiscovery: (live) => dig(live, "metadata", "name") === "default",
};

export const serviceAccountDriver = makeKubernetesDriver(serviceAccountDef);
