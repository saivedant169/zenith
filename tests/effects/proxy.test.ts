/**
 * Runner HTTP proxies in the effect ledger: explicit read allowlists (never HTTP method alone), client tokens,
 * record-before-send, saved replies, uncertain-with-hint on a lost reply. The job calls are in-memory doubles;
 * the ledger is the real control store.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AWS_READ_ACTION_VERBS, classifyAws, classifyOci, classifyK8s, classifyProxyJob, keyAwsRequest, proxyRequestHintResolver, runProxyJob,
  type ProxyAwaited, type ProxyHttpResult, type ProxyScope,
} from "@/lib/effects/proxy";
import { EffectTombstonedError, EffectUnresolvedError, createEffectLedger } from "@/lib/effects/ledger";
import { LANES, openLane } from "../controlplane/_support/harness";
import { seed, type Seed } from "./_support";

const aws = (over: { service?: string; method?: string; headers?: Record<string, string>; body?: string | object; url?: string } = {}) => ({
  service: over.service ?? "ecs", method: over.method ?? "POST", url: over.url ?? "https://ecs.us-east-1.amazonaws.com/",
  headers: over.headers ?? {}, body: Buffer.from(typeof over.body === "string" ? over.body : JSON.stringify(over.body ?? {}), "utf8"),
});
const rpc = (target: string, body: object = {}, service = "ecs") => aws({ service, headers: { "x-amz-target": target, "content-type": "application/x-amz-json-1.1" }, body });
const form = (params: Record<string, string>, service = "ec2") => aws({ service, headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() });

describe("AWS classification: an explicit read allowlist, never the HTTP method", () => {
  it("POST RPC reads are reads, POST RPC changes are mutations", () => {
    for (const target of ["AmazonEC2ContainerServiceV20141113.DescribeServices", "AmazonEC2ContainerServiceV20141113.ListTasks", "CodeBuild_20161006.BatchGetBuilds", "AmazonEC2ContainerServiceV20141113.DescribeTaskDefinition"])
      expect(classifyAws(rpc(target)).mutating, target).toBe(false);
    for (const target of ["CodeBuild_20161006.StartBuild", "AmazonEC2ContainerServiceV20141113.UpdateService", "AmazonEC2ContainerServiceV20141113.RunTask", "AmazonEC2ContainerServiceV20141113.DeregisterTaskDefinition"])
      expect(classifyAws(rpc(target)).mutating, target).toBe(true);
  });

  it("query-protocol actions are read or mutating by their Action", () => {
    expect(classifyAws(form({ Action: "DescribeInstances", Version: "2016-11-15" })).mutating).toBe(false);
    expect(classifyAws(form({ Action: "ListRoles", Version: "2010-05-08" }, "iam")).mutating).toBe(false);
    for (const Action of ["RunInstances", "TerminateInstances", "CreateTags"]) expect(classifyAws(form({ Action, Version: "2016-11-15" })).mutating, Action).toBe(true);
  });

  it("REST reads need GET/HEAD AND a listed service; everything else, including GET on an unlisted service, is mutating", () => {
    expect(classifyAws(aws({ service: "s3", method: "GET", url: "https://b.s3.us-east-1.amazonaws.com/key" })).mutating).toBe(false);
    expect(classifyAws(aws({ service: "s3", method: "HEAD", url: "https://b.s3.us-east-1.amazonaws.com/key" })).mutating).toBe(false);
    expect(classifyAws(aws({ service: "s3", method: "PUT", url: "https://b.s3.us-east-1.amazonaws.com/key" })).mutating).toBe(true);
    expect(classifyAws(aws({ service: "s3", method: "DELETE", url: "https://b.s3.us-east-1.amazonaws.com/key" })).mutating).toBe(true);
    expect(classifyAws(aws({ service: "route53", method: "POST", url: "https://route53.amazonaws.com/2013-04-01/hostedzone/Z1/rrset" })).mutating).toBe(true);
    expect(classifyAws(aws({ service: "somenewservice", method: "GET", url: "https://x.us-east-1.amazonaws.com/things" })).mutating).toBe(true);
  });

  it("an opaque POST with no action name is mutating (fail closed), and a verb must be the whole prefix of a clean action name", () => {
    expect(classifyAws(aws({ method: "POST", body: "not json" })).mutating).toBe(true);
    expect(classifyAws(rpc("Svc_1.GetOrDeleteEverything")).mutating).toBe(false); // starts with a read verb: the allowlist is by action prefix
    expect(classifyAws(rpc("Svc_1.get-all")).mutating).toBe(true);
    expect(classifyAws(rpc("Svc_1.Update")).mutating).toBe(true);
    expect(AWS_READ_ACTION_VERBS).toEqual(["Describe", "List", "Get", "BatchGet", "Head", "Lookup", "Search"]);
  });

  it("reports the token a request already carries, and where", () => {
    expect(classifyAws(rpc("CodeBuild_20161006.StartBuild", { projectName: "p", idempotencyToken: "tok-1" }, "codebuild")).token).toEqual({ where: "body idempotencyToken", value: "tok-1" });
    expect(classifyAws(form({ Action: "RunInstances", ClientToken: "ct-9", Version: "2016-11-15" })).token).toEqual({ where: "body ClientToken", value: "ct-9" });
    expect(classifyAws(aws({ headers: { "x-amz-target": "X.StartThing", "x-amz-client-token": "hdr-1" } })).token).toEqual({ where: "header x-amz-client-token", value: "hdr-1" });
    expect(classifyAws(rpc("AmazonEC2ContainerServiceV20141113.UpdateService", { service: "s" })).token).toBeUndefined();
  });

  it("gives every mutation a readback hint that names what to read", () => {
    expect(classifyAws(rpc("CodeBuild_20161006.StartBuild", {}, "codebuild")).readbackHint).toMatch(/codebuild/);
  });
});

describe("keyAwsRequest adds a deterministic client token where the API supports one", () => {
  it("injects into JSON bodies and form bodies, once, and never overrides a caller's token", () => {
    const start = rpc("CodeBuild_20161006.StartBuild", { projectName: "p" }, "codebuild");
    const keyed = keyAwsRequest(start, "op_1");
    const body = JSON.parse(keyed.body.toString("utf8")) as Record<string, string>;
    expect(body.projectName).toBe("p");
    expect(body.idempotencyToken).toMatch(/^zn-[a-f0-9]{48}$/);
    expect(JSON.parse(keyAwsRequest(start, "op_1").body.toString("utf8")).idempotencyToken).toBe(body.idempotencyToken);
    expect(JSON.parse(keyAwsRequest(start, "op_2").body.toString("utf8")).idempotencyToken).not.toBe(body.idempotencyToken);
    const own = rpc("CodeBuild_20161006.StartBuild", { projectName: "p", idempotencyToken: "mine" }, "codebuild");
    expect(keyAwsRequest(own, "op_1").body).toBe(own.body);
    const run = keyAwsRequest(form({ Action: "RunInstances", ImageId: "ami-1", Version: "2016-11-15" }), "op_1");
    expect(new URLSearchParams(run.body.toString("utf8")).get("ClientToken")).toMatch(/^zn-/);
    expect(new URLSearchParams(run.body.toString("utf8")).get("ImageId")).toBe("ami-1");
  });
  it("leaves reads, unknown APIs and APIs without a token untouched", () => {
    for (const r of [rpc("AmazonEC2ContainerServiceV20141113.DescribeServices"), rpc("AmazonEC2ContainerServiceV20141113.UpdateService", { service: "s" }), aws({ service: "s3", method: "PUT", body: "bytes" })])
      expect(keyAwsRequest(r, "op_1").body).toBe(r.body);
  });
});

describe("OCI and Kubernetes classification", () => {
  it("OCI reads are exactly the observe allowlist; every other request mutates; POST carries its retry token", () => {
    expect(classifyOci({ service: "core", method: "GET", path: "/20160918/vcns", headers: {} }).mutating).toBe(false);
    expect(classifyOci({ service: "core", method: "GET", path: "/20160918/vcns/ocid1.vcn.oc1..aaaa", headers: {} }).mutating).toBe(false);
    expect(classifyOci({ service: "core", method: "GET", path: "/20160918/volumeBackups", headers: {} }).mutating).toBe(true); // GET, but not on the allowlist
    const post = classifyOci({ service: "containerinstances", method: "POST", path: "/20210415/containerInstances", headers: { "opc-retry-token": "retry-1" } });
    expect(post).toMatchObject({ mutating: true, token: { where: "header opc-retry-token", value: "retry-1" } });
    expect(classifyOci({ service: "objectstorage", method: "PUT", path: "/n/ns/b/bucket", headers: {} }).mutating).toBe(true);
  });
  it("Kubernetes reads are GET and the three review POSTs; the rest mutate and name the object to read back", () => {
    expect(classifyK8s({ method: "GET", path: "/api/v1/namespaces/a/pods" }).mutating).toBe(false);
    expect(classifyK8s({ method: "POST", path: "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews" }).mutating).toBe(false);
    for (const [method, path] of [["POST", "/api/v1/namespaces/a/pods"], ["DELETE", "/api/v1/namespaces/a/pods/p"], ["PATCH", "/apis/apps/v1/namespaces/a/deployments/d"], ["PUT", "/api/v1/namespaces/a/configmaps/c"], ["POST", "/apis/authorization.k8s.io/v1/subjectaccessreviews"]] as const)
      expect(classifyK8s({ method, path }).mutating, `${method} ${path}`).toBe(true);
    expect(classifyK8s({ method: "DELETE", path: "/api/v1/namespaces/a/pods/p" }).readbackHint).toContain("GET /api/v1/namespaces/a/pods/p");
  });
  it("classifies a validated job payload of each kind", () => {
    const body = Buffer.from(JSON.stringify({ projectName: "p" })).toString("base64");
    expect(classifyProxyJob("aws.http", { service: "codebuild", method: "POST", url: "https://codebuild.us-east-1.amazonaws.com/", headers: { "x-amz-target": "CodeBuild_20161006.StartBuild" }, bodyB64: body }).mutating).toBe(true);
    expect(classifyProxyJob("oci.http", { service: "core", method: "GET", path: "/20160918/vcns", headers: {}, query: [] }).mutating).toBe(false);
    expect(classifyProxyJob("k8s.http", { method: "PATCH", path: "/apis/apps/v1/namespaces/a/deployments/d" }).mutating).toBe(true);
  });
});

describe.each(LANES)("runProxyJob on the control store ($name)", (lane) => {
  let ctx: Awaited<ReturnType<typeof openLane>>;
  beforeAll(async () => { ctx = await openLane(lane); });
  afterAll(async () => { await ctx.close(); });

  const scopeOf = (s: Seed, mutates = true): ProxyScope => ({ workspaceId: s.workspaceId, operationId: s.operationId, capability: "deployment.deploy", mutates });
  const startBuild = (name = "p") => ({ service: "codebuild", method: "POST", url: "https://codebuild.us-east-1.amazonaws.com/", headers: { "x-amz-target": "CodeBuild_20161006.StartBuild" },
    bodyB64: Buffer.from(JSON.stringify({ projectName: name, idempotencyToken: "zn-tok" })).toString("base64") });
  const describe_ = { service: "codebuild", method: "POST", url: "https://codebuild.us-east-1.amazonaws.com/", headers: { "x-amz-target": "CodeBuild_20161006.BatchGetBuilds" }, bodyB64: Buffer.from("{}").toString("base64") };
  const done = (result: ProxyHttpResult, over: Partial<ProxyAwaited<ProxyHttpResult>> = {}): ProxyAwaited<ProxyHttpResult> => ({ jobId: "job_1", status: "succeeded", uncertain: false, result, ...over });
  const ok = (extra: Partial<ProxyHttpResult> = {}): ProxyHttpResult => ({ status: 200, headers: { "x-amzn-requestid": "rid-1" }, bodyB64: Buffer.from('{"build":{"id":"b-1"}}').toString("base64"), ...extra });

  function harness(settle: (id: string) => Promise<ProxyAwaited<ProxyHttpResult>>, enqueue?: () => Promise<string>) {
    const calls = { enqueue: 0, settle: 0 };
    return { calls, io: { enqueue: vi.fn(async () => { calls.enqueue++; return enqueue ? enqueue() : "job_1"; }), settle: vi.fn(async (id: string) => { calls.settle++; return settle(id); }) } };
  }

  it("reads are never recorded, mutations of a read-only scope or without a ledger pass straight through", async () => {
    const s = await seed(ctx.db);
    const ledger = createEffectLedger(ctx.db);
    const h = harness(async () => done(ok()));
    await runProxyJob({ ledger, scope: scopeOf(s), kind: "aws.http", payload: describe_, ...h.io });
    await runProxyJob({ ledger, scope: scopeOf(s, false), kind: "aws.http", payload: startBuild(), ...h.io });
    await runProxyJob({ ledger: undefined, scope: scopeOf(s), kind: "aws.http", payload: startBuild(), ...h.io });
    expect(h.calls).toEqual({ enqueue: 3, settle: 3 });
    expect(await ledger.list(s.workspaceId, { operationId: s.operationId })).toEqual([]);
  });

  it("records a mutation before it is queued, with its token and a readback hint, then keeps the provider's reply", async () => {
    const s = await seed(ctx.db);
    const ledger = createEffectLedger(ctx.db);
    let during: unknown;
    const h = harness(async () => done(ok()), async () => { during = (await ledger.list(s.workspaceId, { operationId: s.operationId }))[0]; return "job_1"; });
    const out = await runProxyJob({ ledger, scope: scopeOf(s), kind: "aws.http", payload: startBuild(), ...h.io });
    expect(out.result?.status).toBe(200);
    expect(during).toMatchObject({ family: "proxy_request", state: "pending", provider: "aws", idempotencyToken: "zn-tok", idempotencySupported: true,
      target: { action: "CodeBuild_20161006.StartBuild", tokenAt: "body idempotencyToken", readbackHint: expect.stringContaining("codebuild") } });
    const [effect] = await ledger.list(s.workspaceId, { operationId: s.operationId });
    expect(effect).toMatchObject({ state: "accepted", providerReceipt: { resourceId: "job_1", requestIds: ["rid-1"] } });
  });

  it("an identical repeat is answered from the saved reply and never reaches the runner again", async () => {
    const s = await seed(ctx.db);
    const ledger = createEffectLedger(ctx.db);
    const h = harness(async () => done(ok()));
    await runProxyJob({ ledger, scope: scopeOf(s), kind: "aws.http", payload: startBuild(), ...h.io });
    const again = await runProxyJob({ ledger, scope: scopeOf(s), kind: "aws.http", payload: startBuild(), ...h.io });
    expect(again).toMatchObject({ status: "succeeded", uncertain: false, result: { status: 200 }, replayedFromReceipt: true });
    expect(Buffer.from(again.result!.bodyB64!, "base64").toString()).toContain('"b-1"');
    expect(h.calls).toEqual({ enqueue: 1, settle: 1 });
    // a different request is a different effect
    await runProxyJob({ ledger, scope: scopeOf(s), kind: "aws.http", payload: startBuild("other"), ...h.io });
    expect(h.calls.enqueue).toBe(2);
  });

  it("a reply too large to keep is refused on repeat, not re-sent", async () => {
    const s = await seed(ctx.db);
    const ledger = createEffectLedger(ctx.db);
    const h = harness(async () => done(ok({ bodyB64: Buffer.alloc(8000, 65).toString("base64") })));
    await runProxyJob({ ledger, scope: scopeOf(s), kind: "aws.http", payload: startBuild(), ...h.io });
    await expect(runProxyJob({ ledger, scope: scopeOf(s), kind: "aws.http", payload: startBuild(), ...h.io })).rejects.toBeInstanceOf(EffectUnresolvedError);
    expect(h.calls.enqueue).toBe(1);
  });

  it("a lost reply (the wait throws) is uncertain with a readback hint, and no repeat is sent", async () => {
    const s = await seed(ctx.db);
    const ledger = createEffectLedger(ctx.db);
    const h = harness(async () => { throw new Error("socket hang up"); });
    await expect(runProxyJob({ ledger, scope: scopeOf(s), kind: "aws.http", payload: startBuild(), ...h.io })).rejects.toThrow("socket hang up");
    const [effect] = await ledger.list(s.workspaceId, { operationId: s.operationId });
    expect(effect).toMatchObject({ state: "uncertain" });
    expect(effect.stateReason).toMatch(/lost/);
    expect(effect.stateReason).toMatch(/codebuild/);
    await expect(runProxyJob({ ledger, scope: scopeOf(s), kind: "aws.http", payload: startBuild(), ...h.io })).rejects.toBeInstanceOf(EffectUnresolvedError);
    expect(h.calls.enqueue).toBe(1);
  });

  it("a timed-out or failed job and a provider 5xx leave the outcome uncertain", async () => {
    for (const settled of [done(ok(), { status: "timed_out", uncertain: true, result: undefined }), done(ok(), { status: "failed", result: undefined }), done(ok({ status: 500 }))]) {
      const s = await seed(ctx.db);
      const ledger = createEffectLedger(ctx.db);
      const h = harness(async () => settled);
      await runProxyJob({ ledger, scope: scopeOf(s), kind: "aws.http", payload: startBuild(), ...h.io });
      expect((await ledger.list(s.workspaceId, { operationId: s.operationId }))[0].state).toBe("uncertain");
      await expect(runProxyJob({ ledger, scope: scopeOf(s), kind: "aws.http", payload: startBuild(), ...h.io })).rejects.toBeInstanceOf(EffectUnresolvedError);
    }
  });

  it("a request the provider proved it did not apply, or the runner did not execute, does not block a new attempt", async () => {
    for (const settled of [done(ok({ status: 400 })), done(ok({ status: 403 })), done(ok({ status: 429 })), done(ok(), { status: "rejected", result: undefined }), done(ok(), { status: "expired", result: undefined })]) {
      const s = await seed(ctx.db);
      const ledger = createEffectLedger(ctx.db);
      const h = harness(async () => settled);
      await runProxyJob({ ledger, scope: scopeOf(s), kind: "aws.http", payload: startBuild(), ...h.io });
      expect((await ledger.list(s.workspaceId, { operationId: s.operationId }))[0]).toMatchObject({ state: "tombstoned", tombstoneReason: "provider_rejected" });
      h.io.settle.mockResolvedValueOnce(done(ok()));
      await runProxyJob({ ledger, scope: scopeOf(s), kind: "aws.http", payload: startBuild(), ...h.io });
      expect(h.calls.enqueue).toBe(2);
      const states = (await ledger.list(s.workspaceId, { operationId: s.operationId })).map((e) => e.state).sort();
      expect(states).toEqual(["accepted", "tombstoned"]);
    }
  });

  it("a refusal before the job is queued retires that attempt and rethrows", async () => {
    const s = await seed(ctx.db);
    const ledger = createEffectLedger(ctx.db);
    const h = harness(async () => done(ok()), async () => { throw new Error("agent_stale"); });
    await expect(runProxyJob({ ledger, scope: scopeOf(s), kind: "aws.http", payload: startBuild(), ...h.io })).rejects.toThrow("agent_stale");
    expect((await ledger.list(s.workspaceId, { operationId: s.operationId }))[0]).toMatchObject({ state: "tombstoned" });
    expect(h.calls.settle).toBe(0);
  });

  it("OCI POST: the opc-retry-token is recorded as the provider idempotency key", async () => {
    const s = await seed(ctx.db);
    const ledger = createEffectLedger(ctx.db);
    const h = harness(async () => done({ status: 200, headers: { "opc-request-id": "oci-req" } }));
    await runProxyJob({ ledger, scope: scopeOf(s), kind: "oci.http", payload: { service: "containerinstances", method: "POST", path: "/20210415/containerInstances", headers: { "opc-retry-token": "retry-xyz" }, query: [] }, ...h.io });
    const [e] = await ledger.list(s.workspaceId, { operationId: s.operationId });
    expect(e).toMatchObject({ provider: "oci", idempotencyToken: "retry-xyz", idempotencySupported: true, state: "accepted", providerReceipt: { requestIds: ["oci-req"] } });
  });

  it("Kubernetes mutation: no provider token exists, the effect says so and names the object to read", async () => {
    const s = await seed(ctx.db);
    const ledger = createEffectLedger(ctx.db);
    const h = harness(async () => { throw new Error("timeout"); });
    await expect(runProxyJob({ ledger, scope: scopeOf(s), kind: "k8s.http", payload: { method: "DELETE", path: "/api/v1/namespaces/a/pods/p" }, ...h.io })).rejects.toThrow("timeout");
    const [e] = await ledger.list(s.workspaceId, { operationId: s.operationId });
    expect(e).toMatchObject({ provider: "kubernetes", idempotencySupported: false, idempotencyToken: null, state: "uncertain" });
    expect(e.stateReason).toContain("GET /api/v1/namespaces/a/pods/p");
  });

  it("an uncertain proxy effect reads back as 'no automatic readback' with the hint, so it stays uncertain", async () => {
    const s = await seed(ctx.db);
    const ledger = createEffectLedger(ctx.db);
    const h = harness(async () => { throw new Error("reset"); });
    await expect(runProxyJob({ ledger, scope: scopeOf(s), kind: "aws.http", payload: startBuild(), ...h.io })).rejects.toThrow();
    const [e] = await ledger.list(s.workspaceId, { operationId: s.operationId });
    const found = await proxyRequestHintResolver().read({ effect: e, signal: new AbortController().signal });
    expect(found).toMatchObject({ outcome: "unavailable" });
    expect(found.reason).toMatch(/codebuild/);
    await expect(runProxyJob({ ledger, scope: scopeOf(s), kind: "aws.http", payload: startBuild(), ...h.io })).rejects.not.toBeInstanceOf(EffectTombstonedError);
  });
});
