/**
 * Browser-only GitHub install/bind form and both server-side callbacks.
 * A live human workspace admin, hashed expiring state, browser PKCE proof and
 * GitHub user access are all required before binding. Agent headers are refused.
 * No access token or external diagnostics reach HTML, redirects or stored state.
 */
import { NextResponse, type NextRequest } from "next/server";
import { platformDb } from "@/lib/controlplane/db/open";
import { route } from "@/lib/server/request";
import { createGithubApp, githubAppConfig } from "@/lib/sources/github/app";
import { createGithubSourceStore, digest, type GithubBindingState } from "@/lib/sources/github/store";
import { GithubSourceError, numericId, repository } from "@/lib/sources/github/types";
import { browserCaller, callbackUrl, cookieOptions, currentAdminMutation, safeFailure, GITHUB_CALLBACK_PATH, GITHUB_INSTALL_COOKIE } from "../_lib/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const PATH = GITHUB_CALLBACK_PATH;
const COOKIE = GITHUB_INSTALL_COOKIE;
const HEADERS = {
  // same-origin, not no-referrer: under no-referrer a browser sends "Origin: null" on this page's own form POST
  // (Fetch: non-CORS POST), which the step-up origin check refuses. Cross-origin GitHub navigation still gets no referrer.
  "cache-control": "no-store", "referrer-policy": "same-origin", "x-content-type-options": "nosniff",
  // The form's 303 navigation must be able to continue to the fixed GitHub origin.
  "content-security-policy": "default-src 'none'; form-action 'self' https://github.com; frame-ancestors 'none'; base-uri 'none'",
};
function form(current: GithubBindingState | undefined): string {
  const status = current ? `<p>Repository: ${current.binding.owner}/${current.binding.repo}. Source access ${current.revoked ? "revoked" : "connected"}.</p>` : "<p>No repository connected.</p>";
  const revoke = current && !current.revoked ? `<form method="post" action="${PATH}"><input type="hidden" name="action" value="revoke"><input type="hidden" name="version" value="${current.binding.version}"><p>Revoke new source access in this workspace. Existing deployments keep running; an existing fetch may finish. The GitHub App installation remains in GitHub.</p><button type="submit">Revoke source access</button></form>` : "";
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect GitHub source</title><main><h1>Connect GitHub source</h1>${status}<p>Install the Zenith GitHub App, then authorize access to the repository. This replaces this workspace's source binding.</p><form method="post" action="${PATH}"><label>Repository (owner/name) <input name="repository" required maxlength="140" autocomplete="off"></label><button type="submit">Install and bind repository</button></form>${revoke}</main></html>`;
}
const success = `<!doctype html><html lang="en"><meta charset="utf-8"><title>GitHub source connected</title><main><h1>GitHub source connected</h1><p>The workspace source binding was saved.</p><a href="/platform">Return to Zenith</a></main></html>`;
const revoked = `<!doctype html><html lang="en"><meta charset="utf-8"><title>GitHub source revoked</title><main><h1>GitHub source revoked</h1><p>New source access is blocked. Existing deployments keep running.</p><a href="${PATH}">Connect a repository</a></main></html>`;

function parameter(req: NextRequest, key: string): string | undefined {
  const values = req.nextUrl.searchParams.getAll(key);
  if (values.length > 1) throw new GithubSourceError("invalid");
  return values[0];
}
function redirect(url: string): NextResponse { return new NextResponse(null, { status: 303, headers: { ...HEADERS, location: url } }); }
export const GET = route({ workspaceRole: "admin" }, async (req) => {
  const caller = await browserCaller(req, false);
  try {
    const state = parameter(req, "state");
    if (state === undefined) {
      if (req.nextUrl.searchParams.size) throw new GithubSourceError("invalid");
      const current = await createGithubSourceStore(await platformDb()).getState(caller.workspaceId);
      return new NextResponse(form(current), { headers: { ...HEADERS, "content-type": "text/html; charset=utf-8" } });
    }
    const config = githubAppConfig();
    if (!config?.clientId || !/^[A-Za-z0-9._-]{1,100}$/.test(config.clientId) || !config.clientSecretFile) throw new GithubSourceError("unavailable");
    const store = createGithubSourceStore(await platformDb());
    const browserProof = req.cookies.get(COOKIE)?.value ?? "";
    const input = { workspaceId: caller.workspaceId, actorId: caller.principal.id, state, browserProof };
    const code = parameter(req, "code"); const installation = parameter(req, "installation_id");
    if (parameter(req, "error") !== undefined || (code !== undefined && installation !== undefined)) throw new GithubSourceError("refused");
    if (code === undefined) {
      if (!installation || !/^[1-9]\d{0,15}$/.test(installation) || !["install", "update"].includes(parameter(req, "setup_action") ?? "install")) throw new GithubSourceError("invalid");
      const installationId = numericId(Number(installation));
      await currentAdminMutation(req, caller, false, current => current.authorize(input, installationId, config.appId), { appId: config.appId, installationId });
      const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: callbackUrl(req), state, code_challenge: Buffer.from(digest(browserProof), "hex").toString("base64url"), code_challenge_method: "S256" });
      return redirect(`https://github.com/login/oauth/authorize?${params}`);
    }
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(code)) throw new GithubSourceError("invalid");
    const intent = await store.consume(input);
    if (intent.appId !== config.appId) throw new GithubSourceError("refused");
    const repositoryId = await createGithubApp(config).verifyUserRepository({ ...intent, code, verifier: browserProof, callbackUrl: callbackUrl(req) }, AbortSignal.any([req.signal, AbortSignal.timeout(60_000)]));
    await currentAdminMutation(req, caller, false, current => current.bind({ ...intent, repositoryId, workspaceId: caller.workspaceId, actorId: caller.principal.id }), { appId: intent.appId, installationId: intent.installationId, generation: intent.installationGeneration });
    const out = new NextResponse(success, { headers: { ...HEADERS, "content-type": "text/html; charset=utf-8" } });
    out.cookies.set(COOKIE, "", { ...cookieOptions(req), maxAge: 0 });
    return out;
  } catch (error) { return safeFailure(error); }
});

export const POST = route({ workspaceRole: "admin" }, async (req) => {
  const caller = await browserCaller(req, true);
  try {
    if (req.nextUrl.searchParams.size || req.headers.get("content-type")?.split(";")[0] !== "application/x-www-form-urlencoded" || Number(req.headers.get("content-length")) > 1024 || !req.body) throw new GithubSourceError("invalid");
    const reader = req.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    const deadline = AbortSignal.any([req.signal, AbortSignal.timeout(8_000)]);
    try {
      for (;;) {
        const chunk = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
          const abort = () => { deadline.removeEventListener("abort", abort); reject(new GithubSourceError("invalid")); };
          deadline.addEventListener("abort", abort, { once: true });
          void reader.read().then(value => { deadline.removeEventListener("abort", abort); resolve(value); }, () => { deadline.removeEventListener("abort", abort); reject(new GithubSourceError("invalid")); });
          if (deadline.aborted) abort();
        });
        if (chunk.done) break;
        size += chunk.value.byteLength; if (size > 1024) throw new GithubSourceError("invalid"); chunks.push(chunk.value);
      }
    } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const fields = new URLSearchParams(Buffer.concat(chunks, size).toString("utf8"));
    if (fields.has("action")) {
      if ([...fields.keys()].some((key) => !["action", "version"].includes(key)) || fields.getAll("action").length !== 1 || fields.get("action") !== "revoke" || fields.getAll("version").length !== 1 || !/^[1-9]\d{0,9}$/.test(fields.get("version") ?? "")) throw new GithubSourceError("invalid");
      callbackUrl(req);
      await currentAdminMutation(req, caller, true, current => current.revoke({ workspaceId: caller.workspaceId, actorId: caller.principal.id, expectedVersion: numericId(Number(fields.get("version"))) }));
      const out = new NextResponse(revoked, { headers: { ...HEADERS, "content-type": "text/html; charset=utf-8" } });
      out.cookies.set(COOKIE, "", { ...cookieOptions(req), maxAge: 0 });
      return out;
    }
    if ([...fields.keys()].some((key) => key !== "repository") || fields.getAll("repository").length !== 1) throw new GithubSourceError("invalid");
    const parts = (fields.get("repository") ?? "").split("/");
    if (parts.length !== 2) throw new GithubSourceError("invalid");
    const repo = repository(parts[0], parts[1]);
    const config = githubAppConfig();
    if (!config?.clientId || !/^[A-Za-z0-9._-]{1,100}$/.test(config.clientId) || !config.clientSecretFile) throw new GithubSourceError("unavailable");
    callbackUrl(req);
    const intent = await currentAdminMutation(req, caller, true, current => current.begin(caller.workspaceId, caller.principal.id, repo));
    const url = await createGithubApp(config).installUrl(intent.state, req.signal);
    const out = redirect(url); out.cookies.set(COOKIE, intent.browserProof, cookieOptions(req)); return out;
  } catch (error) { return safeFailure(error); }
});
