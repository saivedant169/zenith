import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateConfig, configDigest, readIsolatedBuildConfig, renderBaseline, renderProxy, renderJob, verifyProbe, PROBE_CHECKS,
  assertBaseline, assertPod, verifyJob, validateBuildRequest, createIsolatedBuildPort, verifyPublishedArtifact,  sourceName } from "@/lib/providers/kubernetes/build";
import { dig } from "@/lib/providers/kubernetes/util";
import type { DriverContext } from "@/lib/drivers/types";
import type { ManagedSubstratePort } from "@/lib/providers/zenith/managed-port";
import { serviceNode, node } from "../helpers";
import { newProvenanceKeys } from "../../../execution/fakes/provenance";
import { signBuildProvenance, verifyBuildProvenance, type ProvenanceInput } from "@/lib/execution/build-provenance";
import { immutableSourceSnapshot } from "@/lib/execution/source-snapshot";
import { BUILD_ISOLATION_PROFILES } from "@/lib/execution/build-isolation";

import { config, request } from "./fixtures";
const clone=<T>(v:T):T=>structuredClone(v);
const proof=()=>JSON.stringify({version:1,checks:Object.fromEntries(PROBE_CHECKS.map(k=>[k,true]))});
function readings() {
 return [...renderBaseline(config),...renderProxy(config)].map((o,i)=>({...clone(o),metadata:{...o.metadata,uid:"uid-"+i,generation:1,resourceVersion:"1"},...(o.kind==="Deployment"?{status:{observedGeneration:1,availableReplicas:1}}:{})})).concat([{apiVersion:"node.k8s.io/v1",kind:"RuntimeClass",metadata:{name:config.runtimeClass,uid:"runtime",generation:1,resourceVersion:"1"},handler:"userns"}] as never[]);
}

describe("owned isolated builder admission (contract)",()=>{
 it("refuses absent configuration and mutable images",()=>{
  expect(()=>readIsolatedBuildConfig({})).toThrow(/refused/);
  expect(()=>validateConfig({...config,builderImage:"moby/buildkit:rootless"})).toThrow();
  expect(()=>validateConfig({...config,proxy:{...config.proxy,namespace:config.namespace}})).toThrow();
 });
 it.each(["169.254.169.254","169.254.170.2","127.0.0.1","0.0.0.0"])("refuses metadata or loopback destinations %s",ip=>{
  expect(()=>validateConfig({...config,proxy:{...config.proxy,destinations:[{...config.proxy.destinations[0],ip}]}})).toThrow();
 });
 it("renders read-only root/source, bounded scratch, no token, host user namespaces and full process isolation",()=>{
  const job=renderJob(config,request),pod=dig(job,"spec","template","spec");
  expect(pod).not.toHaveProperty("hostPID"); expect(pod).not.toHaveProperty("hostNetwork"); expect(pod).not.toHaveProperty("hostIPC");
  expect(pod).toMatchObject({hostUsers:false,shareProcessNamespace:false,automountServiceAccountToken:false,runtimeClassName:"userns"});
  expect(dig(pod,"containers",0,"securityContext")).toMatchObject({privileged:false,readOnlyRootFilesystem:true,capabilities:{drop:["ALL"],add:["SETUID","SETGID"]},seccompProfile:{type:"Localhost"}});
  expect(JSON.stringify(job)).not.toContain("no-process-sandbox");
  expect(dig(pod,"containers",0,"env")).not.toEqual(expect.arrayContaining([expect.objectContaining({name:"AWS_ACCESS_KEY_ID"})]));
  expect(dig(pod,"volumes",0)).toEqual({name:"source",secret:{secretName:request.sourceSecret,defaultMode:0o444}});
 });
 it("requires an exact complete live baseline, including proxy readiness",()=>{
  const objects=readings();expect(assertBaseline(config,objects)).toMatch(/^[a-f0-9]{64}$/);
  const open=clone(objects);const policy=open.find(o=>o.kind==="NetworkPolicy")!;policy.spec={podSelector:{},policyTypes:["Egress"],egress:[{}]};
  expect(()=>assertBaseline(config,open)).toThrow();
  expect(()=>assertBaseline(config,objects.filter(o=>o.kind!=="ServiceAccount"))).toThrow();
  expect(()=>assertBaseline(config,[...objects,{apiVersion:"networking.k8s.io/v1",kind:"NetworkPolicy",metadata:{name:"extra",namespace:config.namespace},spec:{egress:[{}]}}])).toThrow(/Additional/);
  const unavailable=clone(objects);Object.assign(unavailable.find(o=>o.kind==="Deployment")!,{status:{observedGeneration:0,availableReplicas:0}});
  expect(()=>assertBaseline(config,unavailable)).toThrow(/not ready/);
 });
 it.each(PROBE_CHECKS)("refuses missing or false runtime proof %s",key=>{
  const value=JSON.parse(proof());delete value.checks[key];expect(()=>verifyProbe(JSON.stringify(value))).toThrow();
  value.checks[key]=false;expect(()=>verifyProbe(JSON.stringify(value))).toThrow();
 });
 it("refuses malformed, oversized and surplus receipts",()=>{
  expect(verifyProbe(proof()).version).toBe(1);
  for(const message of ["x","x".repeat(4097),JSON.stringify({...JSON.parse(proof()),simulated:true})])expect(()=>verifyProbe(message)).toThrow();
 });
 it.each(["envFrom","volumeDevices","lifecycle"])("refuses injected pod fields %s",field=>{
  const expected=renderJob(config,request),pod=clone(dig(expected,"spec","template","spec")) as {containers:Record<string,unknown>[]};
  pod.containers[0][field]=[];expect(()=>assertPod(pod,dig(expected,"spec","template","spec"))).toThrow();
 });
 it("refuses a changed Job, injected volumes, sidecars, entitlements and mounted service-account tokens",()=>{
  const expected=renderJob(config,request);
  type PodFixture = { containers: { name?: string; image?: string; args: string[]; securityContext: { privileged: boolean } }[]; volumes: Record<string, unknown>[]; automountServiceAccountToken: boolean; hostUsers: boolean };
  for(const mutate of [
   (p:PodFixture)=>p.containers.push({name:"extra",image:config.builderImage,args:[],securityContext:{privileged:false}}),
   (p:PodFixture)=>p.volumes.push({name:"deploy",secret:{secretName:"deployment"}}),
   (p:PodFixture)=>p.automountServiceAccountToken=true,
   (p:PodFixture)=>p.containers[0].args.push("--allow=security.insecure"),
   (p:PodFixture)=>p.containers[0].securityContext.privileged=true,
   (p:PodFixture)=>p.hostUsers=true,
  ]){const actual=clone(expected);mutate(dig(actual,"spec","template","spec") as PodFixture);expect(()=>verifyJob(actual as unknown as Record<string,unknown>,expected)).toThrow();}
 });
 it("refuses actual proxy pod credentials, extra arguments and host namespaces",()=>{
  const expected=dig(renderProxy(config).find(o=>o.kind==="Deployment"),"spec","template","spec");
  for(const field of ["env","args"]){const actual=clone(expected) as {containers:Record<string,unknown>[]};actual.containers[0][field]=field==="env"?[{name:"DEPLOY_KEY",value:randomBytes(12).toString("hex")}]:["injected"];expect(()=>assertPod(actual,expected)).toThrow();}
  expect(()=>assertPod({...clone(expected) as Record<string,unknown>,hostNetwork:true},expected)).toThrow();
 });
 it("detects a policy that was changed and restored during execution",()=>{
  const first=readings(),restored=clone(first);restored.find(o=>o.kind==="NetworkPolicy")!.metadata.resourceVersion="2";
  expect(assertBaseline(config,restored)).not.toBe(assertBaseline(config,first));
 });
 it("changes the configuration binding when allowlist or runtime changes",()=>{
  expect(configDigest(config)).not.toBe(configDigest({...config,runtimeClass:"different"}));
  expect(configDigest(config)).not.toBe(configDigest({...config,proxy:{...config.proxy,destinations:[{...config.proxy.destinations[0],ip:"10.96.0.102"}]}}));
 });
 it("keeps the existing Dockerfile-inside-context gate and rejects traversal",()=>{
  expect(()=>validateBuildRequest(request)).not.toThrow();
  for(const dockerfile of ["Dockerfile","../Dockerfile","."]) expect(()=>validateBuildRequest({...request,dockerfile})).toThrow();
  expect(()=>validateBuildRequest({...request,contextDir:"apps/../web"})).toThrow();
 });
 it("binds managed launch identity to the matching tenant without executing a source build",()=>{
  // Pure naming seam only. The operated kind journey uses the real default substrate.
  const managed={registry:()=>({repositoryFor:()=>"registry.test:5000/web"})} as unknown as ManagedSubstratePort;
  const port=createIsolatedBuildPort({config,managed});
  const ctx={workspaceId:request.workspaceId,environmentId:request.environmentId,operationId:request.operationId,provider:"zenith",region:"managed",session:{tenant:{workspaceId:request.workspaceId,environmentId:request.environmentId}}} as unknown as DriverContext;
  const service=node({address:request.serviceAddress,kind:"container_service",provider:"zenith",region:"managed",spec:{artifact:{type:"built",pipeline:request.pipelineAddress,registry:"container_registry/web"}}});
  const pipeline=node({address:request.pipelineAddress,kind:"build_pipeline",provider:"zenith",region:"managed",spec:{source:{contextDir:request.contextDir,dockerfile:request.dockerfile},output:{registry:"container_registry/web"}}});
  const input={service,pipeline,source:{s3Key:sourceName(request.environmentId,request.sourceDigest),bucket:config.namespace,digest:request.sourceDigest},idempotencyKey:request.idempotencyKey};
  expect(port.launchIdentity!(ctx,input)).toMatchObject({namespace:config.namespace});
  const wrong={...ctx,session:{tenant:{workspaceId:"another",environmentId:request.environmentId}}} as unknown as DriverContext;
  expect(()=>port.launchIdentity!(wrong,input)).toThrow(/different workspace or environment/);
 });
 it("refuses an unconfigured native build before source execution",async()=>{
  const port=createIsolatedBuildPort({config});
  await expect(port.startBuild({provider:"kubernetes"} as never,{service:serviceNode(),pipeline:node({address:"build_pipeline/web",kind:"build_pipeline",spec:{source:{},output:{}}})} as never)).rejects.toThrow(/operation identity/);
 });
});

function registryFixture(dependencies: unknown[] = []) {
 const builder="zenith-isolated:test", blobs=new Map<string,Uint8Array>();
 const put=(part:string,value:unknown)=>{const bytes=Buffer.from(JSON.stringify(value)),digest="sha256:"+createHash("sha256").update(bytes).digest("hex");blobs.set(part+"/"+digest,bytes);return digest;};
 const image=put("manifests",{schemaVersion:2,mediaType:"application/vnd.oci.image.manifest.v1+json",layers:[]});
 const statement={_type:"https://in-toto.io/Statement/v1",predicateType:"https://slsa.dev/provenance/v1",subject:[{name:"image",digest:{sha256:image.slice(7)}}],
 predicate:{buildDefinition:{buildType:"https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md",resolvedDependencies:dependencies},runDetails:{builder:{id:builder}}}};
 const layer=put("blobs",statement),attestation=put("manifests",{schemaVersion:2,layers:[{mediaType:"application/vnd.in-toto+json",digest:layer,annotations:{"in-toto.io/predicate-type":"https://slsa.dev/provenance/v1"}}]});
 const digest=put("manifests",{schemaVersion:2,mediaType:"application/vnd.oci.image.index.v1+json",manifests:[
 {digest:image,platform:{os:"linux",architecture:"arm64"}},{digest:attestation,platform:{os:"unknown",architecture:"unknown"},annotations:{"vnd.docker.reference.type":"attestation-manifest","vnd.docker.reference.digest":image}}]});
 return {digest,builder,blobs,layer,reader:{read:async(path:string)=>{const bytes=blobs.get(path);if(!bytes)throw Error("absent");return bytes;}}};
}
describe("published OCI provenance (contract)",()=>{
 it("verifies the index, workload, attestation manifest and statement byte digests",async()=>{const f=registryFixture();expect(await verifyPublishedArtifact(f.reader,f.digest,f.builder)).toBe(f.layer);});
 it("rejects altered bytes, a missing attestation and another builder",async()=>{
  const f=registryFixture();await expect(verifyPublishedArtifact(f.reader,f.digest,"other")).rejects.toThrow();
  f.blobs.set("blobs/"+f.layer,Buffer.from("{}"));await expect(verifyPublishedArtifact(f.reader,f.digest,f.builder)).rejects.toThrow(/digest/);
 });
 it.each([{}, {sha256:"mutable"}])("rejects an unpinned provenance material %j",async digest=>{
  const f=registryFixture([{uri:"pkg:docker/example",digest}]);
  await expect(verifyPublishedArtifact(f.reader,f.digest,f.builder)).rejects.toThrow(/dependencies/);
 });
 it("accepts immutable provenance material digests",async()=>{
  const f=registryFixture([{uri:"pkg:docker/example",digest:{sha256:"a".repeat(64)}}]);
  expect(await verifyPublishedArtifact(f.reader,f.digest,f.builder)).toBe(f.layer);
 });
 it("round trips the existing LIFE-09 signature with generated keys and refuses key revocation or source substitution",async()=>{
  const keys=newProvenanceKeys(),source=immutableSourceSnapshot({format:"zenith.approved-source.v1",workspaceId:"ws",operationId:"op",projectId:"project",environmentId:"env",serviceAddress:request.serviceAddress,serviceSpecDigest:"1".repeat(64),pipelineAddress:request.pipelineAddress,pipelineSpecDigest:"2".repeat(64),provider:"zenith",region:"managed",owner:"example",repo:"web",repositoryId:1,requestedRef:"main",commitSha:"a".repeat(40),githubBinding:null,dockerfile:"apps/web/Dockerfile",dockerfileDigest:"d".repeat(64),recipeDigest:"e".repeat(64),archiveFormat:"tar.gz",archiveDigest:request.sourceDigest,archiveBytes:100});
  const input:ProvenanceInput={workspaceId:"ws",operationId:"op",environmentId:"env",provider:"zenith",serviceAddress:request.serviceAddress,pipelineAddress:request.pipelineAddress,contextDir:request.contextDir,imageName:"registry.test:5000/web",imageDigest:"sha256:"+"b".repeat(64),source,exceptions:[],
   attestation:{builderId:"zenith-isolated:test",invocationId:"job-uid",builderImage:config.builderImage,isolation:{profileId:BUILD_ISOLATION_PROFILES.zenith.id,
   identity:{principal:"system:serviceaccount:zenith-build:zenith-builder",dedicated:true,deployCredentials:"absent"},metadata:{exposes:"none",mechanism:"node-bound probes"},network:{egress:"allowlisted",verifiedBy:"provider_read",allowlistDigest:configDigest(config),mechanism:"allowlist proxy"},dependencies:{downloads:"allowlisted"},filesystem:{sourceMount:"read_only"},resources:{timeoutSec:1800,computeClass:"k8s-2cpu-4gi"}}}};
  const signed=await signBuildProvenance(keys.signerObject,input,new Date()),expected={...input,policy:{allowOpenEgress:false}};
  expect((await verifyBuildProvenance(signed.jws,expected,keys.publicKeys)).exceptions).toEqual([]);
  await expect(verifyBuildProvenance(signed.jws,expected,[])).rejects.toThrow();
  await expect(verifyBuildProvenance(signed.jws,{...expected,source:{...source,archiveDigest:"f".repeat(64)}},keys.publicKeys)).rejects.toThrow();
 });
  it("renders no empty list, empty string or host-namespace false that the API server would drop from the live object", () => {
    // The live baseline and Job comparisons are subset checks, so a dropped field reads as tampering.
    const dropped: string[] = [];
    const walk = (v: unknown, p: string): void => {
      if (Array.isArray(v)) { if (!v.length) dropped.push(p); v.forEach((x, i) => walk(x, p + "[" + i + "]")); }
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (["hostNetwork", "hostPID", "hostIPC"].includes(k) && x === false) dropped.push(p + "." + k); walk(x, p + "." + k); }
      else if (v === "") dropped.push(p);
    };
    for (const o of [...renderBaseline(config), ...renderProxy(config), renderJob(config, request), renderJob(config, request, true, "node-a")]) walk(o, o.kind + "/" + o.metadata.name);
    expect(dropped).toEqual([]);
  });
  it("admits only the exact DefaultTolerationSeconds tolerations admission adds to the executed pod", () => {
    const expected = dig(renderJob(config, request), "spec", "template", "spec") as { tolerations: Record<string, unknown>[] };
    const admitted = (extra: Record<string, unknown>[]) => ({ ...clone(expected) as Record<string, unknown>, tolerations: [...clone(expected.tolerations) as Record<string, unknown>[], ...extra] });
    const defaults = ["node.kubernetes.io/not-ready", "node.kubernetes.io/unreachable"].map(key => ({ key, operator: "Exists", effect: "NoExecute", tolerationSeconds: 300 }));
    expect(() => assertPod(admitted(defaults), expected)).not.toThrow();
    for (const extra of [{ operator: "Exists" }, { ...defaults[0], effect: "NoSchedule" }, { ...defaults[0], tolerationSeconds: undefined }, { ...defaults[1], value: "x" }, { key: "zenith.dev/build-tenant", operator: "Exists" }])
      expect(() => assertPod(admitted([JSON.parse(JSON.stringify(extra))]), expected)).toThrow(/differs/);
  });
});

