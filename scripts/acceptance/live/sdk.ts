import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Json, Transport } from "./contracts";
import type { EnvLike } from "../config";
const nativeTransports = new WeakSet<Transport>();
export function isNativeTransport(transport: Transport): boolean { return nativeTransports.has(transport); }

/** Explicit short-lived credentials only. Never the SDK default chain, IMDS,
 * shared profiles, credential_process, endpoint overrides or privileged fallback. */
export async function sessionCredentials(env: EnvLike) {
  const prohibited = Object.keys(env).filter(k => k.startsWith("AWS_ENDPOINT_URL") || ["AWS_PROFILE", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_EC2_METADATA_SERVICE_ENDPOINT", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"].includes(k));
  if (prohibited.some(k => env[k])) throw new Error("Alternate credential/endpoint sources refused");
  let value: { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string; expiration?: string };
  if (env.ZENITH_LIVE_AWS_SESSION_FILE) {
    if (!path.isAbsolute(env.ZENITH_LIVE_AWS_SESSION_FILE) || env.AWS_ACCESS_KEY_ID || env.AWS_SECRET_ACCESS_KEY || env.AWS_SESSION_TOKEN) throw new Error("One absolute session FILE reference required");
    const data = await readFile(env.ZENITH_LIVE_AWS_SESSION_FILE, "utf8");
    if (data.length > 8192) throw new Error("Session file too large");
    value = JSON.parse(data);
  } else {
    if (env.GITHUB_ACTIONS !== "true" || env.ZENITH_LIVE_AWS_ENVIRONMENT !== "live-sandbox") throw new Error("Use an owner-issued short-lived session FILE or protected GitHub OIDC environment");
    value = { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN };
  }
  if (typeof value.accessKeyId !== "string" || !value.accessKeyId || typeof value.secretAccessKey !== "string" || !value.secretAccessKey || typeof value.sessionToken !== "string" || !value.sessionToken) throw new Error("Short-lived session credentials required; no access-key-only mode");
  if (env.ZENITH_LIVE_AWS_SESSION_FILE && (!value.expiration || !Number.isFinite(Date.parse(value.expiration)) || Date.parse(value.expiration) < Date.now() + 46 * 60_000 || Date.parse(value.expiration) > Date.now() + 3_600_000)) throw new Error("Session FILE requires 46..60 minutes remaining, covering execution and cleanup");
  return { accessKeyId: value.accessKeyId, secretAccessKey: value.secretAccessKey, sessionToken: value.sessionToken };
}

/** Minimal ZIP store format for a fixed no-secret nonce echo handler. */
export function nonceZip(): Uint8Array {
  const name = Buffer.from("index.js"), data = Buffer.from("exports.handler = async (event) => ({ nonce: event.nonce });\n");
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

type SessionCredentials = Awaited<ReturnType<typeof sessionCredentials>>;
const rebuilds = new Set<(credentials: SessionCredentials) => void>();
/** A long scenario (teardown-01) refreshes its one-hour OIDC session mid-run: every live transport rebuilds its clients on the new session. */
export function replaceSessionCredentials(credentials: SessionCredentials): void {
  if (!credentials.accessKeyId || !credentials.secretAccessKey || !credentials.sessionToken) throw new Error("Short-lived session credentials required");
  for (const rebuild of rebuilds) rebuild({ accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, sessionToken: credentials.sessionToken });
}

export async function sdkTransport(region: string, env: EnvLike): Promise<Transport> {
  const credentials = await sessionCredentials(env);
  const [s3, iam, lambda, ecs, rds, route53, sts, ssm, ec2, tag, secrets, logs] = await Promise.all([
    import("@aws-sdk/client-s3"), import("@aws-sdk/client-iam"), import("@aws-sdk/client-lambda"), import("@aws-sdk/client-ecs"), import("@aws-sdk/client-rds"), import("@aws-sdk/client-route-53"), import("@aws-sdk/client-sts"), import("@aws-sdk/client-ssm"), import("@aws-sdk/client-ec2"), import("@aws-sdk/client-resource-groups-tagging-api"), import("@aws-sdk/client-secrets-manager"), import("@aws-sdk/client-cloudwatch-logs"),
  ]);
  type Client = { send(command: unknown, options: { abortSignal: AbortSignal }): Promise<Record<string, unknown>> };
  type Constructor = new (input: unknown) => unknown;
  const modules: Record<string, { module: Record<string, unknown>; client: Client }> = {};
  const build = (credentials: SessionCredentials) => {
    const options = { region, credentials, maxAttempts: 1, useFipsEndpoint: false, useDualstackEndpoint: false, ignoreConfiguredEndpointUrls: true };
    for (const [service, module, ClientCtor] of [
      ["s3", s3, s3.S3Client], ["iam", iam, iam.IAMClient], ["lambda", lambda, lambda.LambdaClient], ["ecs", ecs, ecs.ECSClient], ["rds", rds, rds.RDSClient], ["route53", route53, route53.Route53Client], ["sts", sts, sts.STSClient], ["ssm", ssm, ssm.SSMClient], ["ec2", ec2, ec2.EC2Client], ["tag", tag, tag.ResourceGroupsTaggingAPIClient], ["secretsmanager", secrets, secrets.SecretsManagerClient], ["logs", logs, logs.CloudWatchLogsClient],
    ] as const) modules[service] = { module, client: new ClientCtor(options) as unknown as Client };
  };
  build(credentials);
  rebuilds.add(build);
  const transport: Transport = {
    async send(call, input, signal) {
      const entry = modules[call.service];
      const Command = entry?.module[`${call.command}Command`] as Constructor | undefined;
      if (!Command) throw new Error("Unsupported deterministic AWS command");
      const resolved: Record<string, unknown> = { ...input };
      if (call.command === "CreateFunction") resolved.Code = { ZipFile: nonceZip() };
      if (call.command === "Invoke") resolved.Payload = Buffer.from(JSON.stringify(input.Payload));
      const timeout = AbortSignal.timeout(15_000);
      const response = await entry.client.send(new Command(resolved), { abortSignal: signal ? AbortSignal.any([timeout, signal]) : timeout });
      if (call.command === "GetObject") {
        const body = response.Body as AsyncIterable<Uint8Array> | undefined;
        if (!body) throw new Error("Missing S3 readback body");
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of body) { bytes += chunk.byteLength; if (bytes > 2048) throw new Error("Unexpected oversized S3 readback"); chunks.push(Buffer.from(chunk)); }
        response.Body = Buffer.concat(chunks).toString("utf8");
      }
      if (call.command === "Invoke") response.Payload = Buffer.from(response.Payload as Uint8Array).toString("utf8");
      return response;
    },
  };
  nativeTransports.add(transport);
  return Object.freeze(transport);
}

export function resolveInput(input: Json, responses: Record<string, Record<string, unknown>>): Json {
  if (Array.isArray(input)) return input.map(item => resolveInput(item, responses));
  if (input && typeof input === "object") {
    if ("$ref" in input) {
      if (typeof input.$ref !== "string") throw new Error("Malformed reference");
      const [id, ...keys] = input.$ref.split(".");
      let value: unknown = responses[id];
      for (const key of keys) value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
      const valid = input.$ref === "rds-secret.SecretArn" ? typeof value === "string" && /^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:rds!db-[A-Za-z0-9-]+$/.test(value) : typeof value === "string" && /^\/hostedzone\/Z[A-Z0-9]+$/.test(value);
      if (!valid || typeof value !== "string") throw new Error("Unresolved or invalid resource identity");
      return value.replace(/^\/hostedzone\//, "");
    }
    if ("$keys" in input) {
      // Keys of one bounded listing page only: a DeleteObjects request can never exceed that page, and only retention/ keys are admitted.
      if (typeof input.$keys !== "string") throw new Error("Malformed key reference");
      const listed = responses[input.$keys]?.Contents;
      if (!Array.isArray(listed) || listed.length === 0 || listed.length > 1000) throw new Error("Unbounded or empty key listing");
      return listed.map(item => {
        const key = (item as { Key?: unknown } | null)?.Key;
        if (typeof key !== "string" || !key.startsWith("retention/") || key.length > 1024) throw new Error("Key outside owned retention prefix");
        return { Key: key };
      });
    }
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, resolveInput(value, responses)]));
  }
  return input;
}
