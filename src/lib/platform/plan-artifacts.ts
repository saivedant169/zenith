/** Server-only encrypted custody. Plaintext is callback-scoped; no raw plan is an activity result. */
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { vaultCipherFromEnv } from "@/lib/secrets";
import { tofuFailureCode } from "@/lib/tofu/failure-code";
import { createPlanEngineAuthority, type PlanAdmission, type ApprovedPlan, type StandalonePlanBinding, type SealedStandaloneSettlement } from "@/lib/tofu/engine";
import { createExecutionBroker, dispatchRequirementGap, isDefaultCurrentDispatchRequirement } from "./broker";
import type { BrokerPort, PlanArtifactsPort } from "@/lib/execution/ports";
import type { Sql } from "@/lib/controlplane/types";
import * as artifacts from "@/lib/controlplane/db/repos/plan-artifacts";
import { assertDefaultMcpProductTopology } from "@/lib/controlplane/db/repos/workflow-start-deploy-authority";
import { isOpenedPlatformDbHandle } from "@/lib/controlplane/db/open";
import { digest } from "@/lib/controlplane/digest";
import type { DispatchApprovalSnapshot } from "@/lib/execution/ports";
import * as cleanup from "@/lib/controlplane/db/repos/cleanup-writer-barriers";

interface CleanupCell {
  readonly db: Sql; readonly access: artifacts.ArtifactAccess; readonly attempt: string;
  readonly proof: Readonly<DispatchApprovalSnapshot>; readonly manifestDigest: string; readonly rawAuthenticationDigest: string;
  readonly liveAdmission: () => boolean;
  readonly settlements: readonly artifacts.StandaloneSettlementRow[];
  readonly authenticateSettlements: () => Promise<void>;
  active: boolean; hold?: cleanup.CleanupHold; grantState: "fresh"|"reserved"|"inserted"|"unconfirmed"; jti?: string;
}
interface CleanupOrigin { cell: CleanupCell; stage: "hold"|"grant"|"dispatch"; consumed: boolean }
const cleanupOrigins = new WeakMap<object,CleanupOrigin>();
const cleanupInvocation = new AsyncLocalStorage<CleanupCell>();

/** The same refusal, with a fixed non-secret gate code as its cause so an operator can tell which dispatch gate refused. */
function gateRefusal(code: string): Error {
  return Object.assign(new artifacts.PlanArtifactError(), { cause: { name: "Gate", code } });
}

export interface NativeCleanupOrigin {
  readonly access: artifacts.ArtifactAccess; readonly attempt: string; readonly proof: Readonly<DispatchApprovalSnapshot>;
  readonly manifestDigest: string; readonly rawAuthenticationDigest: string; readonly hold?: cleanup.CleanupHold; readonly jti?: string;
  readonly settlements: readonly artifacts.StandaloneSettlementRow[];
}
async function liveCleanup(cell: CleanupCell): Promise<boolean> {
  if (!cell.active || !cell.liveAdmission() || !isOpenedPlatformDbHandle(cell.db,"postgres")) return false;
  await cell.authenticateSettlements();
  return cell.active && cell.liveAdmission() && isOpenedPlatformDbHandle(cell.db,"postgres")
    && await isDefaultCurrentDispatchRequirement(cell.proof,cell.db,cell.access.custody.workspaceId,cell.access.custody.operationId)
    && cell.active && cell.liveAdmission() && isOpenedPlatformDbHandle(cell.db,"postgres");
}
/** Resolver only: neither copied records nor SQL callers can register an origin. A hold identity is consumed before awaiting. */
export async function readNativeCleanupOrigin(origin: unknown, db: Sql, stage: "hold"|"grant"|"dispatch"): Promise<NativeCleanupOrigin> {
  const entry = origin && typeof origin==="object" ? cleanupOrigins.get(origin) : undefined;
  if (!entry || entry.cell.db!==db || entry.stage!==stage || stage!=="grant" && entry.consumed) throw new cleanup.CleanupWriterBarrierError();
  if(stage!=="grant")entry.consumed=true;
  const cell=entry.cell;
  if(!await liveCleanup(cell) || stage!=="hold" && !cell.hold || stage==="grant" && !cell.jti) throw new cleanup.CleanupWriterBarrierError();
  return Object.freeze({access:cell.access,attempt:cell.attempt,proof:cell.proof,manifestDigest:cell.manifestDigest,
    rawAuthenticationDigest:cell.rawAuthenticationDigest,hold:cell.hold,jti:cell.jti,settlements:cell.settlements});
}
export async function readNativeCleanupInventoryOrigin(origin:unknown,db:Sql):Promise<NativeCleanupOrigin> {
  const entry=origin&&typeof origin==="object"?cleanupOrigins.get(origin):undefined;
  if(!entry || entry.cell.db!==db || !await liveCleanup(entry.cell))throw new cleanup.CleanupWriterBarrierError();
  const cell=entry.cell;
  return Object.freeze({access:cell.access,attempt:cell.attempt,proof:cell.proof,manifestDigest:cell.manifestDigest,
    rawAuthenticationDigest:cell.rawAuthenticationDigest,hold:cell.hold,jti:cell.jti,settlements:cell.settlements});
}
export async function assertNativeCleanupOriginCurrent(origin:unknown,db:Sql):Promise<void> {
  const entry=origin&&typeof origin==="object"?cleanupOrigins.get(origin):undefined;
  if(!entry || entry.cell.db!==db || !await liveCleanup(entry.cell))throw new cleanup.CleanupWriterBarrierError();
}
/** Only an active authenticated default destroy callback can consume its one issuance slot. No operation-wide exemption exists. */
export async function readNativeCleanupOwnerGrantOrigin(db:Sql,operationId:string,capability:string,audience:string,fence?:{scope:string;fenceToken:number}):Promise<object> {
  const cell=cleanupInvocation.getStore();
  if(!cell || cell.db!==db || cell.access.custody.operationId!==operationId || capability!=="infrastructure.destroy" || audience!=="worker"
    || !fence || fence.scope!==cell.access.lease.scope || fence.fenceToken!==cell.access.lease.fenceToken || !cell.hold
    || cell.grantState!=="fresh" || !await liveCleanup(cell) || cell.grantState!=="fresh") throw new cleanup.CleanupWriterBarrierError();
  // Consume locally before any signing or SQL await; loss never creates a second JTI.
  cell.grantState="unconfirmed";
  const origin=Object.freeze({});cleanupOrigins.set(origin,{cell,stage:"grant",consumed:false});return origin;
}
export async function reserveNativeCleanupOwnerGrant(origin:unknown,db:Sql,jti:string):Promise<void> {
  const entry=origin&&typeof origin==="object"?cleanupOrigins.get(origin):undefined;
  if(!entry || entry.stage!=="grant" || entry.cell.db!==db || entry.consumed || entry.cell.jti) throw new cleanup.CleanupWriterBarrierError();
  entry.consumed=true;entry.cell.jti=jti;
  await cleanup.reserveOwnerGrant(db,origin,jti);
  if(!await liveCleanup(entry.cell))throw new cleanup.CleanupWriterBarrierError();
  entry.cell.grantState="reserved";
}
export async function insertNativeCleanupOwnerGrant(origin:unknown,db:Sql,input:import("@/lib/controlplane/db/repos/grants").InsertGrantInput):Promise<void> {
  const entry=origin&&typeof origin==="object"?cleanupOrigins.get(origin):undefined;
  if(!entry || entry.stage!=="grant" || entry.cell.db!==db || entry.cell.grantState!=="reserved" || entry.cell.jti!==input.jti
    || !await liveCleanup(entry.cell) || entry.cell.grantState!=="reserved")throw new cleanup.CleanupWriterBarrierError();
  entry.cell.grantState="unconfirmed";
  await cleanup.insertOwnerGrant(db,origin,input);
  if(!await liveCleanup(entry.cell))throw new cleanup.CleanupWriterBarrierError();
  entry.cell.grantState="inserted";
}

interface StandaloneOriginCell {
  readonly db:Sql; readonly access:artifacts.ArtifactAccess; readonly attempt:string;
  readonly binding:Readonly<StandalonePlanBinding>; readonly receipt?:SealedStandaloneSettlement;
  readonly proof:Readonly<DispatchApprovalSnapshot>; readonly current:()=>boolean;
  readonly authenticate:()=>Promise<void>; readonly stage:"binding"|"completion";
  consumed:boolean;
}
const standaloneOrigins=new WeakMap<object,StandaloneOriginCell>();
/** Shape, SQL records and another engine cannot register this origin. */
export async function readNativeStandaloneOrigin(origin:unknown,db:Sql,stage:"binding"|"completion") {
  const cell=origin&&typeof origin==="object"?standaloneOrigins.get(origin):undefined;
  if(!cell || cell.db!==db || cell.stage!==stage || cell.consumed || !cell.current() || !isOpenedPlatformDbHandle(db,"postgres"))throw new artifacts.PlanArtifactError();
  cell.consumed=true;
  await cell.authenticate();
  if(!cell.current() || !await isDefaultCurrentDispatchRequirement(cell.proof,db,cell.access.custody.workspaceId,cell.access.custody.operationId)
    || !cell.current() || !isOpenedPlatformDbHandle(db,"postgres"))throw new artifacts.PlanArtifactError();
  return Object.freeze({access:cell.access,attempt:cell.attempt,binding:cell.binding,receipt:cell.receipt,proof:cell.proof});
}
export async function assertNativeStandaloneOriginCurrent(origin:unknown,db:Sql):Promise<void> {
  const cell=origin&&typeof origin==="object"?standaloneOrigins.get(origin):undefined;
  if(!cell || cell.db!==db || !cell.current() || !isOpenedPlatformDbHandle(db,"postgres"))throw new artifacts.PlanArtifactError();
  await cell.authenticate();
  if(!cell.current() || !await isDefaultCurrentDispatchRequirement(cell.proof,db,cell.access.custody.workspaceId,cell.access.custody.operationId)
    || !cell.current() || !isOpenedPlatformDbHandle(db,"postgres"))throw new artifacts.PlanArtifactError();
}

export function planArtifactCipherFromEnv(env: Readonly<Record<string,string|undefined>> = process.env) {
  try {
    if (env.ZENITH_PLAN_ARTIFACT_KEY === env.ZENITH_SECRET_KEY || !env.ZENITH_PLAN_ARTIFACT_KEY || !/^[a-f0-9]{64}$/i.test(env.ZENITH_PLAN_ARTIFACT_KEY)) throw new Error();
    const overlap = (raw: string | undefined): string[] => {
      const values: unknown = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(values)) throw new Error();
      return values.map(value => {
        if (typeof value !== "string") throw new Error();
        const bytes = /^[a-f0-9]{64}$/i.test(value.trim()) ? Buffer.from(value.trim(),"hex") : Buffer.from(value.trim(),"base64");
        if (bytes.length !== 32) throw new Error();
        return bytes.toString("hex");
      });
    };
    const artifactKeys = [env.ZENITH_PLAN_ARTIFACT_KEY.toLowerCase(),...overlap(env.ZENITH_PLAN_ARTIFACT_PREVIOUS_KEYS)];
    const vaultKeys = [...(env.ZENITH_SECRET_KEY ? overlap(JSON.stringify([env.ZENITH_SECRET_KEY])) : []),...overlap(env.ZENITH_VAULT_PREVIOUS_SECRET_KEYS)];
    if (artifactKeys.some(key => vaultKeys.includes(key))) throw new Error();
    // PROD-OPS-05: the key registry owns the parsing and the decrypt-only overlap of the plan custody purpose (same AES-256-GCM format and AAD as before). The checks above stay as the fail-closed separation guard.
    return vaultCipherFromEnv(env, { purpose: "enc:plan-artifacts" });
  } catch { throw new Error("Plan artifact keys are unavailable or invalid."); }
}
function pairedRuntime(db: Sql, env: Readonly<Record<string,string|undefined>>, broker: Pick<BrokerPort,"approvalStatus">, kind: PlanArtifactsPort["kind"]) {
  if ((db as Sql & {kind?:string}).kind !== "postgres") throw new Error("Durable plan custody requires PostgreSQL.");
  const capture = artifacts.captureArtifactAccess;
  const admissions = new WeakMap<ApprovedPlan,PlanAdmission>();
  const engine=createPlanEngineAuthority(planArtifactCipherFromEnv(env),original=>admissions.get(original),env);
  const {codec,tofu}=engine;
  const decoded = <T>(row: artifacts.ArtifactRow, fn: (manifest: Readonly<artifacts.ArtifactRow["manifest"]>, bytes: Buffer) => Promise<T>) =>
    codec.withDecoded(row.manifest, { iv:row.iv, authTag:row.auth_tag, ciphertext:row.ciphertext }, fn);
  const port: PlanArtifactsPort = {
    kind,
    async associate(input) {
      const row=await artifacts.associate(db,input);
      try { await decoded(row,async()=>undefined); } catch { throw new artifacts.PlanArtifactError(); }
    },
    async publish(input) {
      try {
        if (!input.produced) throw new artifacts.PlanArtifactError();
        const sealed = codec.sealProduced(input.produced);
        const row = await artifacts.publish(db,{ ...sealed, lease:input.lease, evidence:input.evidence });
        // A repeated semantic plan returns the original only if it still authenticates.
        await decoded(row,async () => undefined);
      } catch { throw new artifacts.PlanArtifactError(); }
    },
    async inspect<T>(input: artifacts.ArtifactAccess, fn: (approved: ApprovedPlan) => Promise<T>) {
      input = capture(input);
      const row = await artifacts.read(db,input);
      try { return await decoded(row,manifest => fn(Object.freeze({manifest}))); } catch { throw new artifacts.PlanArtifactError(); }
    },
    async consume<T>(input: artifacts.ArtifactAccess, fn: (approved: ApprovedPlan, dispatch: () => Promise<void>) => Promise<T>) {
      input = capture(input);
      const attempt = randomUUID();
      const row = await artifacts.claim(db,input,attempt);
      let dispatched = false;
      let finished = false;
      try {
        if (kind === "postgres") {
          // Native absence cannot establish historical product provenance.
          // Only the existing explicit isolated test runtime accepts that seam.
          if (!await artifacts.requiresProductComposition(db, row, input.custody.operationId, attempt)) throw new artifacts.PlanArtifactError();
          await assertDefaultMcpProductTopology(db);
        }
        const result = await decoded(row, async (manifest,bytes) => {
          const approved: ApprovedPlan = Object.freeze({manifest});
          let cleanupCell:CleanupCell|undefined;
          const admission: PlanAdmission = Object.freeze({manifest,bytes,custody:input.custody,attemptId:attempt,lease:input.lease,associated:manifest.operationId !== input.custody.operationId,
            dispatch: async () => {
              if (dispatched || admissions.get(approved)!==admission) throw gateRefusal("readmitted");
              // Current policy/roles are evaluated by the captured broker, never by caller hooks.
              const authority=await broker.approvalStatus(input.custody.operationId);
              if(!authority.approved || authority.rejected || !authority.dispatchApproval || admissions.get(approved)!==admission)
                throw gateRefusal(!authority.approved ? "not-approved" : authority.rejected ? "rejected" : !authority.dispatchApproval ? "no-dispatch-approval" : "readmitted");
              const proof=cleanupCell?.proof??authority.dispatchApproval;
              if (kind === "postgres" && !await isDefaultCurrentDispatchRequirement(proof,db,input.custody.workspaceId,input.custody.operationId))
                throw gateRefusal(`requirement:${await dispatchRequirementGap(proof,db,input.custody.workspaceId,input.custody.operationId).catch(() => "unknown")}`);
              // Lost commit responses are non-replayable; mark locally before awaiting the CAS.
              dispatched=true;
              let cleanupOrigin:object|undefined;
              if(cleanupCell) {
                if(cleanupCell.grantState!=="inserted" || !await liveCleanup(cleanupCell))throw new cleanup.CleanupWriterBarrierError();
                cleanupOrigin=Object.freeze({});cleanupOrigins.set(cleanupOrigin,{cell:cleanupCell,stage:"dispatch",consumed:false});
              }
              const binding=kind==="postgres"?engine.preparedStandalone(approved):undefined;
              let standaloneOrigin:object|undefined;
              if(binding) {
                standaloneOrigin=Object.freeze({});standaloneOrigins.set(standaloneOrigin,{db,access:input,attempt,binding,proof,stage:"binding",consumed:false,
                  current:()=>admissions.get(approved)===admission && engine.preparedStandalone(approved)===binding,
                  authenticate:async()=>{await decoded(row,async()=>undefined);}});
              }
              await artifacts.dispatch(db,input,attempt,proof,cleanupOrigin,standaloneOrigin);
            } });
          admissions.set(approved,admission);
          // Compatibility hook grants no dispatch authority. The paired engine owns the durable boundary.
          try {
            if(kind==="postgres" && manifest.purpose==="destroy") {
              const authority=await broker.approvalStatus(input.custody.operationId),proof=authority.dispatchApproval;
              if(!authority.approved || authority.rejected || !proof || !await isDefaultCurrentDispatchRequirement(proof,db,input.custody.workspaceId,input.custody.operationId)
                || admissions.get(approved)!==admission || !isOpenedPlatformDbHandle(db,"postgres"))throw new cleanup.CleanupWriterBarrierError();
              const candidates=await artifacts.readStandaloneSettlements(db,input.custody,row.manifest.backendDigest);
              const valid:artifacts.StandaloneSettlementRow[]=[];
              for(const receipt of candidates) {
                try {
                  await decoded(receipt.artifact,async()=>undefined);
                  await engine.authenticateStandaloneSettlement(receipt.receipt,receipt.artifact.manifest);
                  valid.push(receipt);
                } catch { /* An unauthenticated row never removes its permanent delivery blocker. */ }
              }
              const settlements=Object.freeze(valid);
              const authenticateSettlements=async()=>{
                for(const receipt of settlements) {
                  await decoded(receipt.artifact,async()=>undefined);
                  await engine.authenticateStandaloneSettlement(receipt.receipt,receipt.artifact.manifest);
                }
              };
              await authenticateSettlements();
              cleanupCell={db,access:input,attempt,proof,manifestDigest:row.manifest_digest,settlements,authenticateSettlements,
                rawAuthenticationDigest:digest({manifest:row.manifest_digest,iv:row.iv,authTag:row.auth_tag,ciphertext:row.ciphertext}),
                liveAdmission:()=>admissions.get(approved)===admission,active:true,grantState:"fresh"};
              const origin=Object.freeze({});cleanupOrigins.set(origin,{cell:cleanupCell,stage:"hold",consumed:false});
              const retained=await cleanup.retain(db,origin);
              // The hold TX has committed before this refusal. Lost acknowledgement never reaches the callback.
              cleanupCell.hold=retained.hold;
              if(Object.values(retained.inventory).some(n=>n!==0))throw new cleanup.CleanupWriterBarrierError();
              const value=await cleanupInvocation.run(cleanupCell,()=>fn(approved,async()=>undefined));
              await finishStandalone(approved,admission);
              return value;
            }
            const value=await fn(approved, async () => undefined);
            await finishStandalone(approved,admission);
            return value;
          } finally { if(cleanupCell)cleanupCell.active=false;admissions.delete(approved); }
        });
        if (!dispatched) throw new artifacts.PlanArtifactError();
        if(!finished)await artifacts.finish(db,input,attempt,true);
        return result;
      } catch (error) {
        await artifacts.finish(db,input,attempt,false).catch(() => undefined);
        if (dispatched) {
          // Safety refusal is unchanged. Only a sanitized class/code (never the message, which may carry secrets) is attached for diagnosis.
          const raw = error as { name?: unknown; code?: unknown } | null;
          const shape = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : undefined;
          const detail = tofuFailureCode(error);
          const cause = Object.freeze({ name: shape(raw?.name) ?? "UnknownError", code: shape(raw?.code), ...(detail ? { detail } : {}) });
          throw new Error("Original plan dispatch outcome is unconfirmed; inspect this operation before another write.", { cause });
        }
        throw error;
      }
      async function finishStandalone(approved:ApprovedPlan,admission:PlanAdmission) {
        if(kind!=="postgres" || !engine.preparedStandalone(approved))return;
        const receipt=engine.takeStandaloneSettlement(approved);
        if(!dispatched || !receipt || admissions.get(approved)!==admission)throw new artifacts.PlanArtifactError();
        const authority=await broker.approvalStatus(input.custody.operationId),proof=authority.dispatchApproval;
        if(!authority.approved || authority.rejected || !proof || admissions.get(approved)!==admission)throw new artifacts.PlanArtifactError();
        const origin=Object.freeze({});standaloneOrigins.set(origin,{db,access:input,attempt,binding:receipt.binding,receipt,proof,stage:"completion",consumed:false,
          current:()=>admissions.get(approved)===admission,
          authenticate:async()=>{await decoded(row,async()=>undefined);await engine.authenticateCurrentStandaloneCompletion(receipt,row.manifest);}});
        await artifacts.finishStandalone(db,origin);
        finished=true;
      }
    },
  };
  return Object.freeze({ planArtifacts: Object.freeze(port), tofu });
}

/** Production always captures the real canonical broker. No per-call hook can replace it. */
export function createPlanArtifactRuntime(db: Sql, env: Readonly<Record<string,string|undefined>> = process.env) {
  return pairedRuntime(db,env,createExecutionBroker(db),"postgres");
}
/** Explicit fixture seam: real SQL/tool custody with isolated scope/role/policy fixtures, never production composition. */
export function createIsolatedPlanArtifactRuntimeForTests(db:Sql,env:Readonly<Record<string,string|undefined>>,broker:Pick<BrokerPort,"approvalStatus">) {
  if(process.env.NODE_ENV!=="test")throw new Error("Isolated plan custody is available only in tests.");
  return pairedRuntime(db,env,broker,"isolated-test");
}

/** Producer-only callers receive no engine or admission-registration capability. */
export function createPlanArtifactsPort(db: Sql, env: Readonly<Record<string,string|undefined>> = process.env): PlanArtifactsPort {
  return createPlanArtifactRuntime(db,env).planArtifacts;
}
