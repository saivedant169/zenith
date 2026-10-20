/** Offline driver planning/receipt/cleanup/provider-wire contracts. Never operated or live evidence. */
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { receiptFor, cleanupAll, cleanupObjects, assertObserver, hash } from "../../../scripts/release/drivers/operated";
import { run as privateRun, assertSnapshot } from "../../../scripts/release/drivers/private-source";
import { run as updateRun, updatePlan, assertReleaseRecords } from "../../../scripts/release/drivers/update-rollback";
import { fixtureResponse, sourceArchive } from "../../../scripts/release/drivers/github-emulator.mjs";
import { requiredChecks, validateLocalReceipt, localTargetLane, LOCAL_TARGETS, localEnvironment } from "../../../scripts/release/local-targets";
import { SCENARIOS } from "../../../scripts/release/scenarios";
import { sourceSnapshotDigest, type ApprovedSourceSnapshot } from "@/lib/execution/source-snapshot";
import { createSourceBundles } from "@/lib/platform/source-bundle";
import { sourceBinary, sourceDockerfile } from "../../../scripts/release/drivers/source-build-fixture";
import { assertBuiltRelease, assertRunningBuiltImage } from "../../../scripts/release/drivers/source-build-readback";
import { isolatedKindConfig } from "../../e2e/default/prepare.mjs";
import { manifestFor, requirementsFor } from "../../../scripts/ci/gate-manifest.mjs";
import { reportFailures } from "../../ci/assert-lane-report.mjs";

const source = { head: randomBytes(20).toString("hex"), contentSha256: randomBytes(32).toString("hex"), dirty: true };
const runId = "drv1-contract";
describe("DRV-1 offline boundary and receipts", () => {
  it("declines before private file, browser or engine access without all explicit gates", async () => {
    for (const run of [privateRun, updateRun]) {
      expect(await run("/missing-receipt", { NODE_ENV: "test" })).toBe(2);
      expect(await run("/missing-receipt", { NODE_ENV: "test", ZENITH_LOCAL_DRV1: "1", ZENITH_LOCAL_TARGETS: "1" })).toBe(2);
    }
  });
  it.each(["private-source", "update-rollback"] as const)("keeps %s missing checks incomplete and binds source bytes", scenario => {
    const receipt = receiptFor(scenario, source, runId, [{ id: "preconditions", status: "passed" }], ["Contract only."]);
    expect(receipt.evidenceLabel).toBe("local_operated_rehearsal");
    expect(receipt.sourceDigest).toBe(source.contentSha256); expect(receipt.dirty).toBe(true);
    expect(receipt.checks.filter(c => c.status === "skipped")).toHaveLength(requiredChecks(scenario).length - 1);
    const expected = { scenarioId: scenario, runId, sourceCommit: source.head };
    for (const invalid of [
      { ...receipt, evidenceLabel: "local_rehearsal" }, { ...receipt, evidenceLabel: "live_sandbox" },
      { ...receipt, sourceDigest: undefined }, { ...receipt, dirty: undefined }, { ...receipt, sourceCommit: "b".repeat(40) },
      { ...receipt, runId: "foreign" }, { ...receipt, checks: receipt.checks.slice(1) },
      { ...receipt, checks: [...receipt.checks, receipt.checks[0]] }, { ...receipt, checks: [...receipt.checks, { id: "unknown", status: "passed" }] },
      { ...receipt, token: randomBytes(32).toString("hex") },
    ]) expect(() => validateLocalReceipt(invalid, expected)).toThrow();
  });
  it("cannot serialize untrusted diagnostics or credentials into receipts", () => {
    const receipt = receiptFor("private-source", source, runId, [], ["Contract only."]);
    expect(Object.keys(receipt).sort()).toEqual(["schema", "evidenceLabel", "scenarioId", "runId", "sourceCommit", "sourceDigest", "dirty", "checks", "limits"].sort());
    expect(() => receiptFor("private-source", source, runId, [{ id: "unknown", status: "passed" }], ["Contract only."])).toThrow();
  });
  it("runs every cleanup task in order even when cancellation and removal fail", async () => {
    const calls: string[] = [];
    const failures = await cleanupAll(["cancel", "delete-owned", "revoke", "close-browser", "restore-j1", "remove-fixture"].map(id => ({ id, run: async () => {
      calls.push(id); if (["cancel", "delete-owned"].includes(id)) throw new Error("private diagnostic");
    } })));
    expect(calls).toEqual(["cancel", "delete-owned", "revoke", "close-browser", "restore-j1", "remove-fixture"]);
    expect(failures).toEqual(["cancel", "delete-owned"]);
  });
  it("refuses foreign namespaces, missing UIDs and shared kinds, and cleans workload before storage", () => {
    const object = (kind: string, environment = "env", namespace = "zenith-j2") => ({ apiVersion: "v1", kind, metadata: {
      name: "owned", uid: randomBytes(8).toString("hex"), namespace, annotations: { "zenith.dev/environment": environment } } });
    expect(cleanupObjects([object("Secret"), object("Deployment"), object("Deployment", "foreign")], "env", "zenith-j2").map(o => o.kind)).toEqual(["Deployment", "Secret"]);
    for (const value of [object("Namespace"), object("Deployment", "env", "foreign"), { ...object("Secret"), metadata: { ...object("Secret").metadata, uid: undefined } }])
      expect(() => cleanupObjects([value], "env", "zenith-j2")).toThrow();
  });
  it("binds observer credentials to the exact local container socket and CA, refusing remote targets and exec plugins", () => {
    const encoded = () => randomBytes(32).toString("base64"), caData = encoded(), containerId = randomBytes(32).toString("hex");
    const target = { caData, containerId, recordedId: containerId, ports: [{ HostIp: "127.0.0.1", HostPort: "42443" }] };
    const config = { "current-context": "kind-zenith-j2", contexts: [{ name: "kind-zenith-j2", context: { cluster: "local", user: "observer" } }],
      clusters: [{ name: "local", cluster: { server: "https://127.0.0.1:42443", "certificate-authority-data": caData } }],
      users: [{ name: "observer", user: { "client-certificate-data": encoded(), "client-key-data": encoded() } }] };
    expect(() => assertObserver(config, target)).not.toThrow();
    for (const change of [{ server: "https://api.real-provider.invalid:42443" }, { server: "https://127.0.0.1:42444" },
      { "certificate-authority-data": encoded() }, { "insecure-skip-tls-verify": true }, { "proxy-url": "https://api.real-provider.invalid" }])
      expect(() => assertObserver({ ...config, clusters: [{ name: "local", cluster: { ...config.clusters[0]!.cluster, ...change } }] }, target)).toThrow();
    expect(() => assertObserver({ ...config, users: [{ name: "observer", user: { ...config.users[0]!.user, exec: { command: "cloud-auth" } } }] }, target)).toThrow();
    expect(() => assertObserver(config, { ...target, recordedId: randomBytes(32).toString("hex") })).toThrow();
  });
  it("registers only the two additive operated targets and source-specific gates", () => {
    for (const id of ["private-source", "update-rollback"]) {
      expect(LOCAL_TARGETS[id]).toMatchObject({ owner: "DRV-1", driver: "scripts/release/drivers/" + id + ".ts" });
      expect(localTargetLane(SCENARIOS.find(s => s.id === id)!)).toMatchObject({ evidenceLabel: "local_operated_rehearsal", gates: expect.arrayContaining(["ZENITH_LOCAL_DRV1=1"]) });
    }
    expect(LOCAL_TARGETS["restore"]?.owner).toBe("DRV-3/J1/J2");
    const stackDirectory = process.cwd();
    expect(localEnvironment({ NODE_EXTRA_CA_CERTS: "/private/j1/ca.crt", AWS_ACCESS_KEY_ID: Array.from({ length: 20 }, (_, n) => n.toString(36)).join(""),
      ZENITH_ACCEPTANCE_DEFAULT_STACK: "1", ZENITH_ACCEPTANCE_DEFAULT_STACK_DIR: stackDirectory }))
      .toMatchObject({ NODE_EXTRA_CA_CERTS: path.join(stackDirectory, "tls/ca.crt"), AWS_EC2_METADATA_DISABLED: "true" });
    expect(localEnvironment({ NODE_EXTRA_CA_CERTS: "/private/j1/ca.crt" })).not.toHaveProperty("NODE_EXTRA_CA_CERTS");
    expect(localEnvironment({ AWS_ACCESS_KEY_ID: randomBytes(8).toString("hex") })).not.toHaveProperty("AWS_ACCESS_KEY_ID");
  });
  it.each(["drv1-private-source", "drv1-update-rollback"])("%s requires its exact operated case; skips cannot satisfy the gate", lane => {
    const manifest = manifestFor(lane), required = requirementsFor(lane, process.cwd());
    expect(manifest.env.ZENITH_LOCAL_DRV1).toBe("1"); expect(required).toHaveLength(1);
    const requirement = required[0]!;
    const report = (status: string) => ({ success: true, numTotalTests: 1, numFailedTests: 0, testResults: [{ name: requirement.file, status: "passed",
      assertionResults: [{ title: requirement.test, fullName: requirement.suite + " " + requirement.test, ancestorTitles: [requirement.suite], status }] }] });
    expect(reportFailures(required, report("passed"), process.cwd())).toEqual([]);
    expect(reportFailures(required, report("pending"), process.cwd()).length).toBeGreaterThan(0);
    expect(reportFailures(required, { success: true, testResults: [] }, process.cwd()).length).toBeGreaterThan(0);
  });
});
describe("DRV-1 immutable source and release readback", () => {
  it("requires a bounded native source executable and a dedicated worker without host injection", () => {
    // The host's own ELF machine is accepted and the other one refused: arm64 is 183, x86_64 is 62.
    const native = process.arch === "x64" ? 62 : 183, foreign = native === 62 ? 183 : 62;
    const bytes = Buffer.alloc(64); Buffer.from([127,69,76,70,2,1]).copy(bytes); bytes.writeUInt16LE(native,18);
    expect(sourceBinary(bytes)).toBe(bytes.toString("base64"));
    for (const invalid of [Buffer.alloc(64), Buffer.alloc(600 * 1024 + 1), Buffer.from(bytes)]) {
      if (invalid.equals(bytes)) invalid.writeUInt16LE(foreign,18);
      expect(() => sourceBinary(invalid)).toThrow();
    }
    const config = { kind: "Cluster", apiVersion: "kind.x-k8s.io/v1alpha4", networking: { apiServerAddress: "127.0.0.1", disableDefaultCNI: true, podSubnet: "10.244.0.0/16" }, nodes: [{role:"control-plane"},{role:"worker"}] };
    expect(isolatedKindConfig(JSON.stringify(config))).toBe(JSON.stringify(config));
    for (const invalid of [{...config,nodes:config.nodes.slice(0,1)}, {...config,nodes:[config.nodes[0],{role:"worker",extraMounts:[{hostPath:"/"}]}]},
      {...config,kubeadmConfigPatches:["untrusted"]}, {...config,networking:{apiServerAddress:"0.0.0.0"}}]) expect(() => isolatedKindConfig(JSON.stringify(invalid))).toThrow();
  });
  it("binds successful release readback and the running platform digest to the verified built index", () => {
    const digest = "sha256:" + hash("index"), platform = "sha256:" + hash("platform"), image = "172.18.0.3:5000/owned/witness@" + digest;
    const snapshot = {operationId:"success"} as ApprovedSourceSnapshot;
    const row = {operation_id:"success",state:"readback_verified",image_uri:image,image_digest:digest,readback:{status:"verified",observedDigest:digest}};
    expect(assertBuiltRelease(row,snapshot)).toEqual({image,digest});
    for (const changed of [{state:"failed"},{operation_id:"foreign"},{image_uri:image.replace(digest,platform)},{readback:{status:"verified",observedDigest:platform}}])
      expect(() => assertBuiltRelease({...row,...changed},snapshot)).toThrow();
    const deployment = {spec:{template:{spec:{containers:[{image}]}}}};
    const pod = {metadata:{name:"owned-pod"},spec:{containers:[{image}]},status:{phase:"Running",conditions:[{type:"Ready",status:"True"}],containerStatuses:[{ready:true,imageID:"owned@"+platform}]}};
    expect(assertRunningBuiltImage(deployment,[pod],image,platform)).toBe("owned-pod");
    for (const invalid of [[],[pod,pod],[{...pod,status:{...pod.status,containerStatuses:[{ready:true,imageID:"owned@sha256:"+hash("foreign")}]}}],
      [{...pod,spec:{containers:[{image:"unreviewed:latest"}]}}]]) expect(() => assertRunningBuiltImage(deployment,invalid,image,platform)).toThrow();
  });
  it("requires successful build and provenance checks in addition to every original receipt assertion", () => {
    const old = ["preconditions","browser-source-binding","private-source-snapshot","browser-snapshot-approval","source-revocation-refused","independent-source-readback","owned-cleanup","source-unchanged"];
    expect(requiredChecks("private-source")).toEqual(expect.arrayContaining(old));
    const receipt = receiptFor("private-source",source,runId,old.map(id=>({id,status:"passed" as const})),["Contract only."]);
    expect(receipt.checks.filter(c=>c.status==="skipped").map(c=>c.id)).toEqual(["source-build-preconditions","isolated-private-build","provenance-verified-deploy","post-revocation-proposal-refused"]);
  });
  it("requires distinct pinned local revisions and deliberately fails the actual empty-nonce workload", () => {
    const base = "localhost:5000/witness@sha256:" + "a".repeat(64), next = "localhost:5000/update@sha256:" + "b".repeat(64);
    const a = randomBytes(12).toString("hex"), b = randomBytes(12).toString("hex");
    expect(updatePlan(base, next, a, b)).toEqual([
      { phase: "baseline", image: base, marker: a, expected: "succeeded" }, { phase: "compatible-update", image: next, marker: b, expected: "succeeded" },
      { phase: "failed-rollout", image: next, marker: "", expected: "failed" }, { phase: "rollback", image: base, marker: a, expected: "succeeded" },
    ]);
    expect(() => updatePlan(base, base, a, b)).toThrow(); expect(() => updatePlan(base, next, a, a)).toThrow();
    expect(() => updatePlan(base.replace("localhost:5000", "ghcr.io"), next, a, b)).toThrow();
  });
  it("requires successful independent digest readbacks plus a confirmed failed release and exact rollback target", () => {
    const expected = { baseline: "one", update: "two", failure: "bad", rollback: "back", baselineRevision: "r1", baseDigest: "sha256:" + "a".repeat(64), updateDigest: "sha256:" + "b".repeat(64) };
    const rows = ["one", "two", "bad", "back"].map(operation_id => ({ operation_id, revision_id: operation_id === "back" ? "r1" : "r-" + operation_id,
      kind: operation_id === "back" ? "rollback" : "deploy", state: operation_id === "bad" ? "failed" : "readback_verified",
      image_digest: ["one", "back"].includes(operation_id) ? expected.baseDigest : expected.updateDigest,
      readback: { status: "verified", observedDigest: ["one", "back"].includes(operation_id) ? expected.baseDigest : expected.updateDigest } }));
    expect(() => assertReleaseRecords(rows, expected)).not.toThrow();
    for (const mutation of [{ state: "uncertain" }, { image_digest: expected.updateDigest }, { revision_id: "foreign" }, { readback: { status: "unsupported" } }])
      expect(() => assertReleaseRecords(rows.map(r => r.operation_id === "back" ? { ...r, ...mutation } : r), expected)).toThrow();
    expect(() => assertReleaseRecords(rows.filter(r => r.operation_id !== "bad"), expected)).toThrow();
    expect(() => assertReleaseRecords([...rows, rows[0]!], expected)).toThrow();
  });
  it("rejects altered source bytes, digest, commit or tenancy even when a row exists", () => {
    const dockerfile = "FROM scratch\n", expected = { workspaceId: "ws", projectId: "proj", environmentId: "env", operationId: "op", commit: "a".repeat(40), archive: hash(sourceArchive(dockerfile)), dockerfile };
    const snapshot: ApprovedSourceSnapshot = { format: "zenith.approved-source.v1", workspaceId: "ws", operationId: "op", projectId: "proj", environmentId: "env",
      serviceAddress: "container_service/witness", serviceSpecDigest: "b".repeat(64), pipelineAddress: "build_pipeline/witness", pipelineSpecDigest: "c".repeat(64),
      provider: "kubernetes", region: "in-cluster", owner: "zenith-local", repo: "private-source", repositoryId: 817, requestedRef: "main", commitSha: expected.commit,
      githubBinding: { appId: "815", installationId: 816, repositoryId: 817, version: 1 }, dockerfile: "Dockerfile", dockerfileDigest: hash(dockerfile),
      recipeDigest: "d".repeat(64), archiveFormat: "tar.gz", archiveDigest: expected.archive, archiveBytes: sourceArchive(dockerfile).length };
    expect(() => assertSnapshot({ snapshot, snapshot_digest: sourceSnapshotDigest(snapshot) }, expected)).not.toThrow();
    for (const mutation of [{ workspaceId: "foreign" }, { commitSha: "b".repeat(40) }, { archiveDigest: "a".repeat(64) }, { githubBinding: null }]) {
      const changed = { ...snapshot, ...mutation };
      expect(() => assertSnapshot({ snapshot: changed, snapshot_digest: sourceSnapshotDigest(changed) }, expected)).toThrow();
    }
  });
});
describe("DRV-1 authenticated local GitHub wire", () => {
  function fixture() {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 }), secret = () => randomBytes(32).toString("hex");
    const config = { appId: "815", installationId: 816, repositoryId: 817, repository: "zenith-local/private-source", publicKey: keys.publicKey,
      installationToken: secret(), userToken: secret(), commit: secret().slice(0, 40), movedCommit: secret().slice(0, 40), dockerfile: "FROM scratch\n" };
    const now = Math.floor(Date.now() / 1000), head = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url"), body = Buffer.from(JSON.stringify({ iss: config.appId, iat: now - 60, exp: now + 540 })).toString("base64url");
    const jwt = head + "." + body + "." + sign("RSA-SHA256", Buffer.from(head + "." + body), keys.privateKey).toString("base64url");
    return { config, jwt, state: { minted: 0, authenticated: 0, refused: 0, archiveReads: 0, movedArchiveReads: 0, moved: false, revoked: false } };
  }
  it("verifies the actual App signature, fixed repository and contents:read token scope", () => {
    const { config, jwt, state } = fixture();
    const request = { host: "api.github.com", url: "/app/installations/816/access_tokens", method: "POST", authorization: "Bearer " + jwt,
      body: { repository_ids: [817], permissions: { contents: "read" } } };
    expect(fixtureResponse(config, state, request).status).toBe(201); expect(state.minted).toBe(1);
    expect(fixtureResponse(config, state, { ...request, authorization: "Bearer " + randomBytes(32).toString("hex") }).status).toBe(403);
    expect(fixtureResponse(config, state, { ...request, body: { repository_ids: [818], permissions: { contents: "read" } } }).status).toBe(403);
    expect(fixtureResponse(config, state, { ...request, body: { repository_ids: [817], permissions: { contents: "write" } } }).status).toBe(403);
  });
  it("exchanges only the matching browser PKCE challenge and refuses token replay", () => {
    const { config, state } = fixture(), secret = () => randomBytes(32).toString("hex"), verifier = secret();
    const oauth = { ...config, callback: "http://127.0.0.1:36400/api/platform/v1/github/callback", clientId: "zenith-local-drv1", clientSecret: secret(), code: secret() };
    const challenge = Buffer.from(hash(verifier), "hex").toString("base64url"), value = randomBytes(32).toString("base64url");
    const url = new URL("https://github.com/login/oauth/authorize");
    for (const [key, field] of Object.entries({ client_id: oauth.clientId, redirect_uri: oauth.callback, state: value, code_challenge_method: "S256", code_challenge: challenge })) url.searchParams.set(key, field);
    const response = fixtureResponse(oauth, state, { host: "github.com", url: url.href, method: "GET" });
    expect(response.status).toBe(303); expect(new URL((response.headers as Record<string, string>).location!).searchParams.get("state")).toBe(value);
    const request = { host: "github.com", url: "/login/oauth/access_token", method: "POST", body: {
      client_id: oauth.clientId, client_secret: oauth.clientSecret, code: oauth.code, redirect_uri: oauth.callback, code_verifier: verifier,
    } };
    expect(fixtureResponse(oauth, state, { ...request, body: { ...request.body, code_verifier: secret() } }).status).toBe(403);
    expect(fixtureResponse(oauth, state, request).status).toBe(200);
    expect(fixtureResponse(oauth, state, request).status).toBe(403);
  });
  it("refuses anonymous and revoked access, never forwards unknown hosts, and retains the old commit after a branch moves", () => {
    const { config, state } = fixture(), request = { host: "api.github.com", url: "/repos/" + config.repository + "/commits/main", method: "GET" };
    expect(fixtureResponse(config, state, request).status).toBe(403);
    const authorized = { ...request, authorization: "Bearer " + config.installationToken };
    state.moved = true;
    expect(fixtureResponse(config, state, authorized).body.toString()).toBe(config.movedCommit);
    expect(fixtureResponse(config, state, { ...authorized, url: request.url.replace("main", config.commit) }).body.toString()).toBe(config.commit);
    expect(fixtureResponse(config, state, { ...authorized, host: "api.real-provider.invalid" }).status).toBe(404);
    state.revoked = true; expect(fixtureResponse(config, state, authorized).status).toBe(403);
  });
  it("the fixture archive digest independently agrees with the production canonicalizer", async () => {
    const dockerfile = "FROM scratch\n", bytes = sourceArchive(dockerfile, "fixture-/");
    const bundles = createSourceBundles({ fetchImpl: async () => new Response(bytes, { status: 200 }), withGithubAccess: async (_scope, fn) => fn() });
    const result = await bundles.read({ repo: "zenith-local/private-source", ref: "a".repeat(40), dockerfile: "Dockerfile" });
    expect(result.sha256).toBe(hash(sourceArchive(dockerfile)));
  });
  it("the private executable archive agrees with the production canonicalizer without dropping source bytes", async () => {
    const app = randomBytes(1024).toString("base64"), bytes = sourceArchive(sourceDockerfile,"fixture-/",app);
    const bundles = createSourceBundles({fetchImpl:async()=>new Response(bytes,{status:200}),withGithubAccess:async(_scope,fn)=>fn()});
    const result = await bundles.read({repo:"zenith-local/private-source",ref:"a".repeat(40),dockerfile:"Dockerfile"});
    expect(result.sha256).toBe(hash(sourceArchive(sourceDockerfile,"",app)));
    expect(result.sha256).not.toBe(hash(sourceArchive(sourceDockerfile)));
  });
});
