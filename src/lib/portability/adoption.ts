/**
 * Adoption: taking an existing, unmanaged resource under management.
 *
 * Three things must hold, and each has one owner:
 *
 *   1. A human made an explicit claim naming the EXACT provider object
 *      (`externalId`), what Zenith may do with it later (`lifecycle`) and, per
 *      field, who owns it afterwards. The claim is part of the immutable proposal
 *      digest the approver reviewed (`claimDigest`).
 *   2. The live object is the object claimed: a fresh, real, non-simulated
 *      observation with presence "present" and the same externalId. The executor
 *      checks this; a claim cannot adopt something that is not there.
 *   3. Field ownership comes from the LIFE-12 registry, never from the claim: a
 *      claim may only confirm what the registry says (an autoscaled replica count
 *      stays the autoscaler's, a provider-chosen zone stays the provider's). A
 *      contradicting claim is refused, and moving a field needs the existing
 *      approved ownership transfer.
 *
 * The drift baseline is what the live object looked like at adoption, limited
 * to fields the IaC now owns. Later drift is measured against it, and fields
 * the registry gives to an autoscaler, a native operation or the provider are
 * expected variance, not drift.
 */
import { z } from "zod";
import { digest } from "@/lib/controlplane/digest";
import { defaultFieldOwnershipRegistry, normalizePath, type FieldOwner, type OwnershipFacts } from "@/lib/ownership";
import type { ObservedValue } from "@/lib/resources/types";
import { PortabilityError } from "./types";

export const ADOPTION_LIFECYCLES = ["manage", "manage_and_destroy"] as const;
export type AdoptionLifecycle = (typeof ADOPTION_LIFECYCLES)[number];

export const AdoptionClaimSchema = z
  .object({
    /** the exact provider id (ARN, resource id, name) of the object being claimed */
    externalId: z.string().min(1).max(500),
    /** the claimant states they own this object and authorize Zenith to manage it */
    acknowledge: z.literal(true),
    /**
     * `manage`: Zenith configures and observes it; it can never delete it (release it instead).
     * `manage_and_destroy`: a later human-approved destroy may delete it.
     */
    lifecycle: z.enum(ADOPTION_LIFECYCLES).prefault("manage"),
    /** optional confirmation of field owners; must equal the registry's answer */
    fields: z.array(z.object({ path: z.string().min(1).max(200), owner: z.enum(["iac", "native-op", "autoscaler", "provider-managed"]) }).strict()).max(50).prefault([]),
    note: z.string().max(500).optional(),
  })
  .strict();
export type AdoptionClaim = z.infer<typeof AdoptionClaimSchema>;

export const AdoptInputSchema = z.object({ claim: AdoptionClaimSchema }).strict();
export const ReleaseInputSchema = z.object({ adoptionId: z.string().min(1).max(200), reason: z.string().max(500).optional() }).strict();

export interface AdoptionIdentity {
  workspaceId: string;
  environmentId: string;
  address: string;
  provider: string;
  nativeType: string;
}

/** What the approver reviewed, bound to this exact resource. Recomputed by the executor, never trusted from input. */
export function claimDigest(identity: AdoptionIdentity, claim: AdoptionClaim): string {
  return digest({
    v: 1,
    identity,
    externalId: claim.externalId,
    lifecycle: claim.lifecycle,
    fields: [...claim.fields].map((f) => ({ path: normalizePath(f.path), owner: f.owner })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  });
}

export interface FieldOwnerEntry { path: string; owner: FieldOwner; source: "rule" | "default"; ruleId?: string }

/** Who owns each registry-governed field of this resource after adoption. */
export function fieldOwnersFor(nativeType: string, address: string, facts: OwnershipFacts): FieldOwnerEntry[] {
  const out: FieldOwnerEntry[] = [];
  for (const rule of defaultFieldOwnershipRegistry.rulesForType(nativeType)) {
    for (const path of rule.paths) {
      const r = defaultFieldOwnershipRegistry.resolve({ resourceType: nativeType, path, address, facts });
      out.push({ path: normalizePath(path), owner: r.owner, source: r.source === "rule" ? "rule" : "default", ...(r.ruleId ? { ruleId: r.ruleId } : {}) });
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** A claim may only confirm the registry. A contradiction is refused with the exact field. */
export function assertClaimMatchesRegistry(nativeType: string, address: string, facts: OwnershipFacts, claim: AdoptionClaim): FieldOwnerEntry[] {
  const owners = fieldOwnersFor(nativeType, address, facts);
  for (const f of claim.fields) {
    const r = defaultFieldOwnershipRegistry.resolve({ resourceType: nativeType, path: f.path, address, facts });
    if (r.owner !== f.owner) {
      throw new PortabilityError(
        "invalid_input",
        `The claim says ${normalizePath(f.path)} is owned by ${f.owner}, but the field ownership registry gives it to ${r.owner}. A claim confirms ownership; moving a field needs an approved ownership transfer.`,
        { path: normalizePath(f.path), claimed: f.owner, registry: r.owner }
      );
    }
  }
  return owners;
}

export interface DriftBaseline {
  v: 1;
  observedAt: string;
  /** only IaC-owned, known attributes */
  attributes: Record<string, unknown>;
  /** attributes left out because another owner holds them */
  excluded: { path: string; owner: FieldOwner }[];
  digest: string;
}

const MAX_BASELINE_BYTES = 64 * 1024;

const known = (v: ObservedValue): v is Extract<ObservedValue, { state: "known" }> => v.state === "known";

/** Capture the baseline from a live observation's attributes. */
export function buildBaseline(input: { nativeType: string; address: string; attributes: Record<string, ObservedValue>; facts: OwnershipFacts; observedAt: string }): DriftBaseline {
  const attributes: Record<string, unknown> = {};
  const excluded: DriftBaseline["excluded"] = [];
  for (const name of Object.keys(input.attributes).sort()) {
    const value = input.attributes[name]!;
    if (!known(value)) continue;
    const owner = defaultFieldOwnershipRegistry.resolve({ resourceType: input.nativeType, path: name, address: input.address, facts: input.facts }).owner;
    if (owner === "iac") attributes[name] = value.value;
    else excluded.push({ path: normalizePath(name), owner });
  }
  const body = { v: 1 as const, observedAt: input.observedAt, attributes, excluded };
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BASELINE_BYTES) throw new PortabilityError("limit_exceeded", "The resource's observed configuration is too large to record as a drift baseline.");
  return { ...body, digest: digest({ attributes, excluded }) };
}

export interface BaselineDrift {
  attribute: string;
  kind: "changed" | "missing" | "added";
  baseline?: unknown;
  current?: unknown;
}

/** Drift of the live object from its adoption baseline, over IaC-owned fields only. */
export function compareToBaseline(baseline: Pick<DriftBaseline, "attributes">, current: Record<string, ObservedValue>, ctx: { nativeType: string; address: string; facts: OwnershipFacts }): BaselineDrift[] {
  const out: BaselineDrift[] = [];
  const live = new Map<string, unknown>();
  for (const [name, value] of Object.entries(current)) {
    if (!known(value)) continue;
    if (defaultFieldOwnershipRegistry.resolve({ resourceType: ctx.nativeType, path: name, address: ctx.address, facts: ctx.facts }).owner !== "iac") continue;
    live.set(name, value.value);
  }
  for (const [name, was] of Object.entries(baseline.attributes)) {
    if (!live.has(name)) out.push({ attribute: name, kind: "missing", baseline: was });
    else if (digest(live.get(name)) !== digest(was)) out.push({ attribute: name, kind: "changed", baseline: was, current: live.get(name) });
  }
  for (const [name, value] of live) if (!(name in baseline.attributes)) out.push({ attribute: name, kind: "added", current: value });
  return out.sort((a, b) => (a.attribute < b.attribute ? -1 : a.attribute > b.attribute ? 1 : 0));
}

/** The live object must be the one claimed. Reasons carry no values. */
export function assertClaimedObjectIsLive(input: {
  claim: AdoptionClaim;
  rowExternalId?: string;
  observation: { presence: string; externalId?: string; simulated: boolean } | null;
  sandbox: boolean;
}): void {
  const o = input.observation;
  if (!o || o.presence !== "present") throw new PortabilityError("ownership_unproven", "The claimed object was not found by a live read; it cannot be adopted.");
  if (o.simulated && !input.sandbox) throw new PortabilityError("ownership_unproven", "Only a simulated observation exists for this resource; adoption needs a real read.");
  if (!o.externalId || o.externalId !== input.claim.externalId) throw new PortabilityError("ownership_unproven", "The live object's identity is not the identity the claim names.");
  if (input.rowExternalId && input.rowExternalId !== input.claim.externalId) throw new PortabilityError("ownership_unproven", "The stored resource points at a different object than the claim names.");
}
