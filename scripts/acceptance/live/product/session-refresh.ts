/**
 * TEARDOWN-01 outlives its one-hour OIDC session: the wait for deploy settlement alone is about 80 minutes. Before the teardown
 * this requests a fresh GitHub OIDC token, exchanges it for a new session of the same sandbox role in the same account (as
 * the workflow's configure-aws-credentials step did), rebuilds the harness clients on it, rewrites the Zenith stack's shared
 * credentials file and restarts the API and the execution worker, whose AWS SDK reads that file once per process.
 *
 * No value is logged, returned or passed on a command line. It lives in memory and in the stack's existing credentials file.
 */
import { execFile } from "node:child_process";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { EnvLike } from "../../config";
import { replaceSessionCredentials } from "../sdk";
import { refuse } from "./mix-03";

export interface RefreshedSession { accessKeyId: string; secretAccessKey: string; sessionToken: string; account: string }
export interface SessionRefreshSeams {
  token?: (url: string, bearer: string) => Promise<string>;
  assume?: (input: { region: string; roleArn: string; sessionName: string; token: string }) => Promise<RefreshedSession>;
  write?: (file: string, contents: string) => Promise<void>;
  docker?: (args: string[]) => Promise<string>;
  installation?: () => Promise<string>;
  replace?: (session: RefreshedSession) => void;
  sleep?: (ms: number) => Promise<void>;
}

const ROLE_ARN = /^arn:aws:iam::(\d{12}):role\/[\w+=,.@-]{1,64}$/;
/** Required exactly once; the peers of the default profile, when present, at most once. */
const SERVICES = { api: true, "execution-worker": true, "api-peer": false, "execution-worker-peer": false } as const;

async function githubToken(url: string, bearer: string): Promise<string> {
  const target = new URL(url);
  target.searchParams.set("audience", "sts.amazonaws.com");
  const response = await fetch(target, { headers: { authorization: `bearer ${bearer}` }, signal: AbortSignal.timeout(15_000) });
  const value = response.ok ? ((await response.json()) as { value?: unknown }).value : undefined;
  return typeof value === "string" && value.length > 0 ? value : refuse("GitHub did not issue an OIDC token for the session refresh");
}

async function assumeWithWebIdentity(input: { region: string; roleArn: string; sessionName: string; token: string }): Promise<RefreshedSession> {
  const { STSClient, AssumeRoleWithWebIdentityCommand } = await import("@aws-sdk/client-sts");
  const sts = new STSClient({ region: input.region, maxAttempts: 2 });
  try {
    const out = await sts.send(new AssumeRoleWithWebIdentityCommand({ RoleArn: input.roleArn, RoleSessionName: input.sessionName, WebIdentityToken: input.token, DurationSeconds: 3600 }),
      { abortSignal: AbortSignal.timeout(15_000) });
    const c = out.Credentials, account = /^arn:aws:sts::(\d{12}):assumed-role\//.exec(out.AssumedRoleUser?.Arn ?? "")?.[1];
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !account) refuse("the refreshed sandbox session is incomplete");
    return { accessKeyId: c!.AccessKeyId!, secretAccessKey: c!.SecretAccessKey!, sessionToken: c!.SessionToken!, account: account! };
  } finally { sts.destroy(); }
}

const run = promisify(execFile);
const docker = async (args: string[]) => (await run("docker", args, { timeout: 120_000 })).stdout;

/** Atomic replace in the stack's directory, readable by the containers' non-root users as the workflow wrote it. */
async function writeShared(file: string, contents: string): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  try { await writeFile(temporary, contents, { mode: 0o644 }); await rename(temporary, file); }
  catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}

export async function refreshSandboxSession(env: EnvLike, seams: SessionRefreshSeams = {}): Promise<void> {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL, bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, roleArn = env.ZENITH_LIVE_OIDC_ROLE_ARN?.trim() ?? "";
  const region = env.ZENITH_LIVE_REGION?.trim() ?? "", account = env.ZENITH_LIVE_AWS_ACCOUNT_ID?.trim() ?? "", dir = env.ZENITH_LIVE_AWS_SHARED_DIR?.trim() ?? "";
  if (!url || !bearer) refuse("no GitHub OIDC token request is available to refresh the sandbox session");
  if (ROLE_ARN.exec(roleArn)?.[1] !== account) refuse("the session refresh role is not in the declared sandbox account");
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region) || !path.isAbsolute(dir)) refuse("the session refresh has no region or shared credentials directory");
  // This stack's own installation id (default-stack/up.mjs state), so no other installation's container is ever touched.
  const installation = await (seams.installation ?? (async () => {
    const file = env.ZENITH_LIVE_STACK_STATE?.trim() ?? "";
    if (!path.isAbsolute(file)) refuse("the session refresh has no stack state file");
    return String((JSON.parse(await readFile(file, "utf8")) as { installationId?: unknown }).installationId ?? "");
  }))();
  if (!/^[0-9a-f]{24}$/.test(installation)) refuse("the stack state has no installation id");
  const token = await (seams.token ?? githubToken)(url!, bearer!);
  const sessionName = `zenith-live-acceptance-${/^\d{1,20}$/.test(env.GITHUB_RUN_ID ?? "") ? env.GITHUB_RUN_ID : "run"}-refresh`.slice(0, 64);
  const session = await (seams.assume ?? assumeWithWebIdentity)({ region, roleArn, sessionName, token });
  if (session.account !== account) refuse("the refreshed session is not in the declared sandbox account");
  (seams.replace ?? replaceSessionCredentials)(session);
  const write = seams.write ?? writeShared;
  await write(path.join(dir, "credentials"), `[default]\naws_access_key_id = ${session.accessKeyId}\naws_secret_access_key = ${session.secretAccessKey}\naws_session_token = ${session.sessionToken}\n`);
  await write(path.join(dir, "config"), `[default]\nregion = ${region}\n`);
  // Only this installation's API and worker containers, found by their compose service and installation labels.
  const exec = seams.docker ?? docker, sleep = seams.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const ids: string[] = [];
  for (const [service, required] of Object.entries(SERVICES)) {
    const found = (await exec(["ps", "-q", "--filter", `label=io.zenith.installation=${installation}`, "--filter", `label=com.docker.compose.service=${service}`])).split(/\s+/).filter(id => /^[0-9a-f]{12,64}$/.test(id));
    if (found.length > 1 || (required && found.length !== 1)) refuse(`expected ${required ? "one" : "at most one"} running ${service} container to restart, found ${found.length}`);
    ids.push(...found);
  }
  await exec(["restart", "--time", "30", ...ids]);
  for (let attempt = 1; ; attempt++) {
    const states = (await exec(["inspect", "--format", "{{.State.Health.Status}}", ...ids])).split(/\s+/).filter(Boolean);
    if (states.length === ids.length && states.every(state => state === "healthy")) return;
    if (attempt >= 60) refuse("the API and execution worker were not healthy within 5 minutes of the session refresh");
    await sleep(5_000);
  }
}
