/**
 * Capability-grant signing and verification (RUNNER-PROTOCOL §1, ADR-0007).
 *
 * A grant is a compact JWS, header `{"alg":"EdDSA","kid":…,"typ":"zenith-grant+jwt"}`,
 * signed by the control-plane key and verified against PINNED public keys —
 * never against a key named by the token itself (`jwk`/`jku`/`x5*` headers are
 * rejected, `alg` other than EdDSA — including `none` — is rejected).
 *
 * Verification is strict about time: `exp` is not extended by any tolerance
 * (an expired grant is expired), `iat` may be at most 60 s in the future to
 * absorb clock skew, and a grant may not live longer than one hour (the
 * maximum `requestedDurationSec` in the capability catalog).
 *
 * What this module does NOT do: single-use consumption and revocation are
 * database state owned by the capability-broker workstream. Pass `isRevoked`
 * (and consume the `jti` in the same transaction that claims the operation);
 * a `true` from the hook rejects the grant.
 *
 * Errors carry a stable `code` and a fixed message; the token is never echoed.
 */
import { createPublicKey } from "node:crypto";
import { compactVerify } from "jose";
import { z } from "zod";
import type { CapabilityGrantClaims } from "@/lib/controlplane/types";
import type { EnvLike } from "./config";
import { GrantVerificationError } from "./errors";
import { getControlSigner, getControlVerificationKeys } from "./signing";
import type { JwtSigner, PublicJwk } from "./signing/types";

export const GRANT_TYP = "zenith-grant+jwt";
export const GRANT_CLOCK_SKEW_SEC = 60;
export const MAX_GRANT_LIFETIME_SEC = 3600;
const MAX_GRANT_BYTES = 16 * 1024;

const str = (max = 300) => z.string().min(1).max(max);

const ClaimsSchema = z.object({
  jti: str(),
  iss: str(),
  aud: str(),
  sub: str(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  cap: str(100),
  op: str(),
  digest: str(),
  ws: str(),
  proj: str().optional(),
  env: str().optional(),
  res: str().optional(),
  fence: z.number().int().nonnegative().optional(),
  constraints: z.record(z.string(), z.unknown()).optional(),
});

function checkLifetime(iat: number, exp: number): void {
  if (exp <= iat || exp - iat > MAX_GRANT_LIFETIME_SEC) {
    throw new GrantVerificationError(
      "grant_lifetime_invalid",
      `A grant must expire after it is issued and live at most ${MAX_GRANT_LIFETIME_SEC} seconds.`
    );
  }
}

/* --------------------------------- signing -------------------------------- */

export interface SignGrantDeps {
  signer?: JwtSigner;
  env?: EnvLike;
}

/** Sign a grant with the control-plane key. Refuses malformed claims rather than signing them. */
export async function signCapabilityGrant(claims: CapabilityGrantClaims, deps: SignGrantDeps = {}): Promise<string> {
  const parsed = ClaimsSchema.safeParse(claims);
  if (!parsed.success) {
    throw new GrantVerificationError("grant_bad_claims", "Refusing to sign a grant with malformed claims.");
  }
  checkLifetime(parsed.data.iat, parsed.data.exp);
  const signer = deps.signer ?? (await getControlSigner(deps.env));
  if (!signer) {
    throw new GrantVerificationError("grant_no_keys", "ZENITH_CONTROL_SIGNING_JWK (or ZENITH_CONTROL_KMS_KEY_ID) is not configured.");
  }
  if (signer.alg !== "EdDSA") {
    throw new GrantVerificationError("grant_bad_header", "The control-plane grant signer must use EdDSA.");
  }
  return signer.sign({ typ: GRANT_TYP }, parsed.data as Record<string, unknown>);
}

/* ------------------------------- verification ------------------------------ */

export interface VerifyGrantOptions {
  /** who is presenting: `worker`, `runner:<id>`, `machine:<id>` — must equal the grant's `aud` */
  audience: string;
  expectedCapability?: string;
  expectedOperationId?: string;
  /** injectable clock */
  now?: Date;
  /** DB-backed revocation / single-use check; `true` rejects */
  isRevoked?: (jti: string) => boolean | Promise<boolean>;
  /** pinned public keys; default: the configured control key plus `ZENITH_CONTROL_EXTRA_PUBLIC_JWKS` */
  keys?: readonly PublicJwk[];
  env?: EnvLike;
  /** optionally pin `iss` */
  issuer?: string;
}

const B64U = /^[A-Za-z0-9_-]+$/;
const FORBIDDEN_HEADERS = ["jwk", "jku", "x5u", "x5c", "x5t", "x5t#S256", "crit"] as const;

function decodeHeader(part: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new GrantVerificationError("grant_malformed", "The grant is not a well-formed compact JWS.");
}

export async function verifyCapabilityGrant(jws: string, options: VerifyGrantOptions): Promise<CapabilityGrantClaims> {
  if (typeof jws !== "string" || jws.length === 0 || jws.length > MAX_GRANT_BYTES) {
    throw new GrantVerificationError("grant_malformed", "The grant is not a well-formed compact JWS.");
  }
  const parts = jws.split(".");
  if (parts.length !== 3 || !parts.every((p) => p.length > 0 && B64U.test(p))) {
    throw new GrantVerificationError("grant_malformed", "The grant is not a well-formed compact JWS.");
  }
  const header = decodeHeader(parts[0]);
  if (header.alg !== "EdDSA" || header.typ !== GRANT_TYP || typeof header.kid !== "string" || !header.kid) {
    throw new GrantVerificationError("grant_bad_header", `A grant must have alg EdDSA, typ ${GRANT_TYP} and a kid.`);
  }
  if (FORBIDDEN_HEADERS.some((h) => h in header)) {
    throw new GrantVerificationError("grant_bad_header", "The grant header contains members that are not accepted.");
  }

  const keys = options.keys ?? (await getControlVerificationKeys(options.env));
  if (keys.length === 0) {
    throw new GrantVerificationError("grant_no_keys", "No control-plane public key is pinned; cannot verify grants.");
  }
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
    throw new GrantVerificationError("grant_unknown_key", "The grant was signed with a key that is not pinned.");
  }

  let payloadBytes: Uint8Array;
  try {
    const key = createPublicKey({ key: jwk as never, format: "jwk" });
    ({ payload: payloadBytes } = await compactVerify(jws, key, { algorithms: ["EdDSA"] }));
  } catch {
    throw new GrantVerificationError("grant_bad_signature", "The grant signature is invalid.");
  }

  let claims: CapabilityGrantClaims;
  try {
    const parsed = ClaimsSchema.safeParse(JSON.parse(Buffer.from(payloadBytes).toString("utf8")));
    if (!parsed.success) throw new Error("claims");
    claims = parsed.data as CapabilityGrantClaims;
  } catch {
    throw new GrantVerificationError("grant_bad_claims", "The grant claims are missing or malformed.");
  }

  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (claims.iat > now + GRANT_CLOCK_SKEW_SEC) {
    throw new GrantVerificationError("grant_not_yet_valid", "The grant was issued in the future.");
  }
  if (claims.exp <= now) throw new GrantVerificationError("grant_expired", "The grant has expired.");
  checkLifetime(claims.iat, claims.exp);

  if (options.issuer !== undefined && claims.iss !== options.issuer) {
    throw new GrantVerificationError("grant_bad_claims", "The grant was issued by an unexpected issuer.");
  }
  if (claims.aud !== options.audience) {
    throw new GrantVerificationError("grant_wrong_audience", "The grant was not issued for this audience.");
  }
  if (options.expectedCapability !== undefined && claims.cap !== options.expectedCapability) {
    throw new GrantVerificationError("grant_wrong_capability", "The grant is for a different capability.");
  }
  if (options.expectedOperationId !== undefined && claims.op !== options.expectedOperationId) {
    throw new GrantVerificationError("grant_wrong_operation", "The grant is for a different operation.");
  }
  if (options.isRevoked && (await options.isRevoked(claims.jti))) {
    throw new GrantVerificationError("grant_revoked", "The grant has been revoked or already used.");
  }
  return claims;
}
