/** TEARDOWN-01 mid-run session refresh, offline: fake OIDC token, STS exchange, file writes and docker. */
import { describe, expect, it } from "vitest";
import { refreshSandboxSession, type RefreshedSession } from "../../scripts/acceptance/live/product/session-refresh";

const ACCOUNT = "123456789012";
const env = {
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example/x?api-version=2.0", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-bearer",
  ZENITH_LIVE_OIDC_ROLE_ARN: `arn:aws:iam::${ACCOUNT}:role/ZenithLiveAcceptance`, ZENITH_LIVE_AWS_ACCOUNT_ID: ACCOUNT,
  ZENITH_LIVE_REGION: "ap-south-1", ZENITH_LIVE_AWS_SHARED_DIR: "/runner/temp/zenith-aws", GITHUB_RUN_ID: "123",
};
const fresh: RefreshedSession = { accessKeyId: "ASIAFRESH", secretAccessKey: "fresh-secret", sessionToken: "fresh-token", account: ACCOUNT };

function seams(opts: { account?: string; health?: string[][]; containers?: Record<string, string> } = {}) {
  const writes: Record<string, string> = {}, dockerCalls: string[][] = [], replaced: RefreshedSession[] = [];
  const health = [...(opts.health ?? [["healthy healthy"]])].map(h => h.join(" "));
  const containers = opts.containers ?? { api: "aaaaaaaaaaaa", "execution-worker": "bbbbbbbbbbbb", "api-peer": "" };
  let assumed: unknown;
  return {
    writes, dockerCalls, replaced, assumed: () => assumed,
    seams: {
      token: async (url: string, bearer: string) => { expect([url, bearer]).toEqual([env.ACTIONS_ID_TOKEN_REQUEST_URL, "request-bearer"]); return "oidc-jwt"; },
      assume: async (input: unknown) => { assumed = input; return { ...fresh, account: opts.account ?? ACCOUNT }; },
      write: async (file: string, contents: string) => { writes[file] = contents; },
      replace: (s: RefreshedSession) => { replaced.push(s); },
      sleep: async () => undefined,
      docker: async (args: string[]) => {
        dockerCalls.push(args);
        if (args[0] === "ps") return `${containers[args.at(-1)!.split("=").at(-1)!] ?? ""}\n`;
        if (args[0] === "inspect") return health.shift() ?? "healthy healthy";
        return "";
      },
    },
  };
}

describe("TEARDOWN-01 session refresh", () => {
  it("exchanges a new OIDC token for the same role, rewrites the stack's credentials and restarts only the API and worker", async () => {
    const s = seams({ health: [["starting healthy"], ["healthy healthy"]] });
    await refreshSandboxSession(env, s.seams);
    expect(s.assumed()).toEqual({ region: "ap-south-1", roleArn: env.ZENITH_LIVE_OIDC_ROLE_ARN, sessionName: "zenith-live-acceptance-123-refresh", token: "oidc-jwt" });
    expect(s.replaced).toEqual([fresh]);
    expect(s.writes["/runner/temp/zenith-aws/credentials"]).toBe("[default]\naws_access_key_id = ASIAFRESH\naws_secret_access_key = fresh-secret\naws_session_token = fresh-token\n");
    expect(s.writes["/runner/temp/zenith-aws/config"]).toBe("[default]\nregion = ap-south-1\n");
    expect(s.dockerCalls.filter(a => a[0] === "restart")).toEqual([["restart", "--time", "30", "aaaaaaaaaaaa", "bbbbbbbbbbbb"]]);
    expect(s.dockerCalls.filter(a => a[0] === "inspect")).toHaveLength(2);
    // No credential value ever reaches a command line.
    expect(JSON.stringify(s.dockerCalls)).not.toMatch(/FRESH|fresh-secret|fresh-token|oidc-jwt/);
  });

  it("refuses a session from another account before writing or restarting anything", async () => {
    const s = seams({ account: "999999999999" });
    await expect(refreshSandboxSession(env, s.seams)).rejects.toThrow("not in the declared sandbox account");
    expect(s.writes).toEqual({}); expect(s.replaced).toEqual([]); expect(s.dockerCalls).toEqual([]);
  });

  it("refuses a role outside the sandbox account, a missing OIDC request, or a relative directory", async () => {
    for (const bad of [{ ZENITH_LIVE_OIDC_ROLE_ARN: "arn:aws:iam::999999999999:role/x" }, { ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" }, { ZENITH_LIVE_AWS_SHARED_DIR: "relative" }]) {
      const s = seams();
      await expect(refreshSandboxSession({ ...env, ...bad }, s.seams)).rejects.toThrow();
      expect(s.writes).toEqual({});
    }
  });

  it("refuses when the API or worker container is not found, and bounds the health wait", async () => {
    await expect(refreshSandboxSession(env, seams({ containers: { api: "", "execution-worker": "bbbbbbbbbbbb" } }).seams)).rejects.toThrow("expected one running api container");
    await expect(refreshSandboxSession(env, seams({ health: new Array(70).fill(["unhealthy healthy"]) }).seams)).rejects.toThrow("not healthy within 5 minutes");
  });
});
