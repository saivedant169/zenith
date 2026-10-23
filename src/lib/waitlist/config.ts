import { z } from "zod";

const Flag = z.enum(["0", "1"]).prefault("0");
const Schema = z.object({
  enabled: Flag,
  gateEnabled: Flag,
  adminIds: z.string().prefault(""),
  existingUsersBefore: z.string().datetime({ offset: true }).optional(),
  rateLimitSecret: z.string().min(32).optional(),
  trustedIpHeader: z.enum(["x-forwarded-for", "x-real-ip", "x-vercel-forwarded-for"]).optional(),
}).superRefine((value, ctx) => {
  if (value.gateEnabled === "1" && !value.existingUsersBefore)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["existingUsersBefore"], message: "Set ZENITH_WAITLIST_EXISTING_USERS_BEFORE before enabling the access gate." });
  if (value.enabled === "1" && !value.rateLimitSecret)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rateLimitSecret"], message: "Set ZENITH_WAITLIST_RATE_LIMIT_SECRET before enabling public intake." });
  for (const id of value.adminIds.split(",").map((item) => item.trim()).filter(Boolean)) {
    if (!z.string().guid().safeParse(id).success)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["adminIds"], message: "ZENITH_WAITLIST_ADMIN_IDS must contain Supabase user UUIDs." });
  }
});

const optional = (key: string): string | undefined => process.env[key]?.trim() || undefined;

/** Server configuration; never expose the private rate-limit salt to a client. */
export function waitlistConfig() {
  const result = Schema.safeParse({
    enabled: optional("ZENITH_WAITLIST_ENABLED"),
    gateEnabled: optional("ZENITH_WAITLIST_GATE_ENABLED"),
    adminIds: optional("ZENITH_WAITLIST_ADMIN_IDS"),
    existingUsersBefore: optional("ZENITH_WAITLIST_EXISTING_USERS_BEFORE"),
    rateLimitSecret: optional("ZENITH_WAITLIST_RATE_LIMIT_SECRET"),
    trustedIpHeader: optional("ZENITH_WAITLIST_TRUSTED_IP_HEADER"),
  });
  if (!result.success) {
    // Do not echo raw values: the rate-limit salt is private.
    throw new Error("Invalid waitlist configuration: " + result.error.issues.map((issue) => issue.path.join(".") + ": " + issue.message).join("; "));
  }
  return {
    enabled: result.data.enabled === "1",
    gateEnabled: result.data.gateEnabled === "1",
    adminIds: new Set(result.data.adminIds.split(",").map((id) => id.trim()).filter(Boolean)),
    existingUsersBefore: result.data.existingUsersBefore,
    rateLimitSecret: result.data.rateLimitSecret,
    trustedIpHeader: result.data.trustedIpHeader,
  };
}

export const waitlistEnabled = (): boolean => waitlistConfig().enabled;
export const waitlistGateEnabled = (): boolean => waitlistConfig().gateEnabled;