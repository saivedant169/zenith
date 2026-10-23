/** Shared wire contract; only the platform authority can produce a lease. */
import { z } from "zod/v4";
import { INTEGRATION_SCOPES, TOOL_NAMES } from "@/lib/agent-access/v3/contract";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
export const launchIds = z.array(id).min(1).max(100).refine((v) => new Set(v).size === v.length);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const LaunchBinding = z.strictObject({
  registrationId: id, workspaceId: id, manifestDigest: digest,
  credentialDigest: digest, audience: z.string().url(),
});
export type LaunchBinding = z.infer<typeof LaunchBinding>;
export const LaunchLease = LaunchBinding.extend({
  status: z.literal("active"), credentialKind: z.literal("plugin_scoped_za"),
  projectIds: launchIds, environmentIds: launchIds,
  tools: z.array(z.enum(TOOL_NAMES)).min(1).max(TOOL_NAMES.length).refine((v) => new Set(v).size === v.length),
  scopes: z.array(z.enum(INTEGRATION_SCOPES)).min(1).max(INTEGRATION_SCOPES.length).refine((v) => new Set(v).size === v.length),
  expiresAt: z.string().datetime(),
});
export type LaunchLease = z.infer<typeof LaunchLease>;
export const LAUNCH_TOKEN_PATTERN = /^za_[A-Za-z0-9_-]{43}$/;
export const LAUNCH_CHECK_PATH = "/api/integrations/plugins/launch/check";
