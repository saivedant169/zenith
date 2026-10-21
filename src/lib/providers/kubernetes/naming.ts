/**
 * Deterministic names for Kubernetes objects and label values.
 *
 * Kubernetes names are DNS-1123 labels here (`[a-z0-9-]`, ≤ 63, alphanumeric
 * at both ends), the strictest common denominator (Service names are DNS-1035,
 * so they must also start with a letter). Whenever sanitizing or truncating
 * CHANGES the input, a 6-hex fnv1a suffix of the original is appended so two
 * different inputs can never collapse to the same name (`a.b` → `a-b-<hash>`,
 * `a-b` → `a-b`). Pure; no clock, no randomness.
 */
import { createHash } from "node:crypto";
import type { ResourceNode } from "@/lib/resources/types";

export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
export const isDnsLabel = (s: string): boolean => DNS_LABEL.test(s);

const hash6 = (s: string) => fnv1a(s).slice(0, 6);
/** A short deterministic DNS-safe tag for an environment, for names that must not collide in a shared namespace. */
export const environmentTag = (environmentId: string): string => hash6(environmentId);

/** A DNS-1035 label: lowercase alphanumerics and `-`, starts with a letter, ends alphanumeric. */
export function dnsLabel(input: string, max = 63): string {
  let out = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (out === "") out = "x";
  if (!/^[a-z]/.test(out)) out = `n${out}`;
  if (out === input && out.length <= max) return out;
  const suffix = `-${hash6(input)}`;
  const room = max - suffix.length;
  const base = out.slice(0, room).replace(/-+$/g, "");
  return `${base || "x"}${suffix}`;
}

/** `service/web` → `web`; `dns_record/app.example.com` → `app.example.com`. */
export function addressLeaf(address: string): string {
  const i = address.indexOf("/");
  return i === -1 ? address : address.slice(i + 1);
}

/** The Kubernetes object name a node renders its primary object under. */
export function objectName(node: Pick<ResourceNode, "address">): string {
  return dnsLabel(addressLeaf(node.address));
}

/** A valid label VALUE: `[A-Za-z0-9._-]`, alphanumeric at both ends, ≤ 63. */
export function labelValue(input: string): string {
  const cleaned = input
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
  if (cleaned === input && cleaned.length > 0 && cleaned.length <= 63) return input;
  const suffix = `-${hash6(input)}`;
  const base = cleaned.slice(0, 63 - suffix.length).replace(/[^A-Za-z0-9]+$/g, "");
  return `${base || "x"}${suffix}`;
}

/** The namespace an environment lives in when nothing names one. */
export const defaultNamespace = (environmentId: string): string => dnsLabel(`zenith-${environmentId}`);

/**
 * The name of the Secret object that carries a secret reference. Derived from
 * the REFERENCE only (never a value), so every service that mounts
 * `vault:p/s/KEY` and the `secret` node that materializes it agree on the name
 * without coordinating. A 10-hex sha256 of the full reference keeps two
 * references that share a tail distinct.
 */
export function secretObjectName(secretRef: string): string {
  const tail =
    (secretRef.split(/[/:]/).filter(Boolean).pop() ?? "secret")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "secret";
  const h = createHash("sha256").update(secretRef).digest("hex").slice(0, 10);
  return `zs-${tail}-${h}`;
}

/** The Secret cert-manager writes a certificate's key pair into; the Ingress references it by this name. */
export function tlsSecretName(domain: string): string {
  return dnsLabel(`tls-${domain}`);
}

/** A reference looks like `scheme:rest` (`vault:…`, `arn:…`); a bare string is more likely a value. */
export function looksLikeSecretRef(ref: string): boolean {
  return /^[a-z][a-z0-9+.-]{1,30}:[^\s]{1,400}$/.test(ref);
}
