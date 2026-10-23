import { isIP } from "node:net";
import { z } from "zod";
import { digest } from "@/lib/controlplane/digest";
import { StepFailedError } from "@/lib/execution/errors";

export const PINNED_IMAGE = /^[a-z0-9][a-z0-9.:/_-]*@sha256:[a-f0-9]{64}$/;
const label = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const ip = z.string().refine(value => isIP(value) === 4, "An IPv4 address is required");
const host = z.string().regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/).refine(value => !value.includes(".."));
export const ConfigSchema = z.object({
  namespace: label,
  builderImage: z.string().regex(PINNED_IMAGE),
  runtimeClass: label,
  seccompProfile: z.string().regex(/^[A-Za-z0-9/_-]+\.json$/).refine(value => !value.includes("..")),
  appArmorProfile: z.string().regex(/^[A-Za-z0-9_-]+$/),
  nodeIsolation: z.object({
    tenant: label,
    profileDigest: z.string().regex(/^[a-f0-9]{64}$/),
    systemDaemonSets: z.array(label).max(16),
  }).strict(),
  proxy: z.object({ namespace: label, ip, port: z.number().int().min(1024).max(65535), image: z.string().regex(PINNED_IMAGE),
    destinations: z.array(z.object({ host, ip, port: z.number().int().min(1).max(65535), tls: z.boolean() }).strict()).min(1).max(64),
  }).strict(),
  pushSecret: label.optional(),
  timeoutSec: z.number().int().min(60).max(1800).prefault(1800),
}).strict();
export type IsolatedBuildConfig = z.infer<typeof ConfigSchema>;

export function validateConfig(raw: unknown): IsolatedBuildConfig {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) throw new StepFailedError("Isolated builds require complete digest-pinned builder, runtime profiles and allowlist proxy configuration.");
  const c = result.data;
  const forbidden = (value: string) => value.startsWith("169.254.") || value.startsWith("127.") || value === "0.0.0.0";
  if (c.namespace === c.proxy.namespace || c.proxy.destinations.some(d => forbidden(d.ip)) || forbidden(c.proxy.ip)) {
    throw new StepFailedError("The proxy must be separate from build pods and may not allow loopback or metadata destinations.");
  }
  const names = c.proxy.destinations.map(d => `${d.host}:${d.port}`);
  if (new Set(names).size !== names.length) throw new StepFailedError("Proxy destinations must be unambiguous.");
  return c;
}

export function readIsolatedBuildConfig(env: Record<string, string | undefined> = process.env): IsolatedBuildConfig {
  let raw: unknown;
  try { raw = JSON.parse(env.ZENITH_ISOLATED_BUILD_CONFIG ?? ""); }
  catch { throw new StepFailedError("Source builds are refused until ZENITH_ISOLATED_BUILD_CONFIG declares an owned isolated builder."); }
  return validateConfig(raw);
}
export const configDigest = (config: IsolatedBuildConfig): string => digest(validateConfig(config));
export const proxyUrl = (config: IsolatedBuildConfig): string => `http://${config.proxy.ip}:${config.proxy.port}`;

