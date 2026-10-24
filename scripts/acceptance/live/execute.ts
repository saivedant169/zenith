import { Guard } from "./guard";
import { digest, teardownOrder } from "./plan";
import { isNativeTransport, resolveInput } from "./sdk";
import { tagsMatch, inventoryEmpty, teardownUntilFailure } from "./shared";
import type { Call, Check, Family, Journal, Json, Plan, ProductScenarioPort, Transport } from "./contracts";

const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" ? v as Record<string, unknown> : {};
const rows = (v: unknown): Record<string, unknown>[] => Array.isArray(v) ? v.map(record) : [];
export function missing(error: unknown): boolean {
  return ["NoSuchBucket", "NotFound", "NoSuchEntityException", "ResourceNotFoundException", "DBInstanceNotFoundFault", "NoSuchHostedZone"].includes(record(error).name as string);
}
export function absent(call: Call, response: Record<string, unknown>): boolean {
  // A secret scheduled for deletion still describes, with DeletedDate set.
  if (call.service === "secretsmanager") return !!response.DeletedDate;
  return call.service === "ecs" && Array.isArray(response.clusters) && Array.isArray(response.failures) && (response.clusters.length + response.failures.length > 0) && rows(response.clusters).every(c => c.status === "INACTIVE") && rows(response.failures).every(f => f.reason === "MISSING");
}
export function owned(response: Record<string, unknown>, plan: Plan): boolean {
  const data = response.Tags ?? response.TagSet ?? response.TagList ?? response.tags ?? record(response.ResourceTagSet).Tags;
  const tags = Array.isArray(data) ? Object.fromEntries(rows(data).map(t => [t.Key ?? t.key, t.Value ?? t.value])) : record(data);
  return tagsMatch(tags, plan.tags);
}
export function checkReadback(family: Family, responses: Record<string, Record<string, unknown>>, plan: Plan): boolean {
  if (family === "s3") return responses["s3-read"]?.Body === plan.settings.runId && Object.values(record(responses["s3-read-private"]?.PublicAccessBlockConfiguration)).length === 4 && Object.values(record(responses["s3-read-private"]?.PublicAccessBlockConfiguration)).every(v => v === true);
  if (family === "iam") return record(record(responses["iam-read"]?.Role).PermissionsBoundary).PermissionsBoundaryArn === plan.settings.workloadBoundaryArn;
  if (family === "lambda") {
    const response = responses["lambda-invoke"];
    try { return response.StatusCode === 200 && !response.FunctionError && JSON.parse(String(response.Payload)).nonce === plan.settings.runId; } catch { return false; }
  }
  if (family === "ecs") return rows(responses["ecs-read"]?.clusters).some(c => c.status === "ACTIVE" && c.clusterName === `zenith-${plan.settings.runId}-ecs`) && rows(responses["ecs-read"]?.failures).length === 0;
  if (family === "rds") return rows(responses["rds-ready"]?.DBInstances).some(db => db.DBInstanceStatus === "available" && db.PubliclyAccessible === false && db.StorageEncrypted === true && db.MultiAZ === false);
  return rows(responses["dns-read"]?.ResourceRecordSets).some(r => r.Type === "TXT" && r.Name === `probe.zenith-${plan.settings.runId}.invalid.` && rows(r.ResourceRecords).some(v => v.Value === `"${plan.settings.runId}"`));
}
export interface ExecutionIO {
  save(journal: Journal): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): Date;
}
export function newJournal(plan: Plan, guard: Guard, commit: string, now = new Date()): Journal {
  return { schema: 1, provenance: "contract", plan, permissionSha256: digest(guard.permission), commit, startedAt: now.toISOString(), attempted: [], responses: {}, checks: [], counts: {}, closed: false };
}
export function executionProvenance(previous: Journal["provenance"], native: boolean, cleanupOnly: boolean): Journal["provenance"] {
  return native && (!cleanupOnly || previous === "live_sandbox") ? "live_sandbox" : "contract";
}

/** Writes intent before every call. Only stable non-secret resource identities and
 * counters are persisted, never provider bodies, secrets, credentials or plan state. */
export async function execute(plan: Plan, guard: Guard, transport: Transport, journal: Journal, io: ExecutionIO, options: { cleanupOnly?: boolean; signal?: AbortSignal; product?: ProductScenarioPort } = {}): Promise<Journal> {
  if (journal.schema !== 1 || journal.plan.sha256 !== plan.sha256 || digest(journal.plan) !== digest(plan) || journal.permissionSha256 !== digest(guard.permission) || !/^[a-f0-9]{40}$/.test(journal.commit) || journal.attempted.some(f => !plan.fixtures.some(p => p.family === f))) throw new Error("Journal plan/permission/commit identity mismatch");
  // Recovery can retain genuine earlier provenance, but cleanup reads cannot
  // turn modeled historical fixture/product checks into live execution evidence.
  journal.provenance = executionProvenance(journal.provenance, isNativeTransport(transport), !!options.cleanupOnly);
  const responses: Record<string, Record<string, unknown>> = { ...journal.responses };
  let cleanup = false;
  let cleanupStarted = 0;
  const add = (check: Check) => journal.checks.push(check);
  const started = io.now().getTime();
  const save = async () => { journal.counts = { ...guard.counts }; await io.save(journal); };
  const call = async (c: Call) => {
    if (cleanupStarted && io.now().getTime() - cleanupStarted >= 25 * 60_000) throw new Error("Cleanup observation deadline reached; owner recovery required");
    if (!cleanup && (options.signal?.aborted || io.now().getTime() - started >= plan.settings.durationMinutes * 60_000)) throw new Error("Live run cancelled or duration envelope exhausted");
    guard.consume(c, cleanup);
    await save();
    const input = resolveInput(c.input, responses) as Record<string, Json>;
    const out = await transport.send(c, input, cleanup ? undefined : options.signal);
    responses[c.id] = out;
    if (c.service === "rds" && c.command === "DescribeDBInstances") {
      const secretArn = record(rows(out.DBInstances)[0]?.MasterUserSecret).SecretArn;
      if (typeof secretArn === "string") {
        if (!secretArn.startsWith(`arn:aws:secretsmanager:${plan.settings.region}:${plan.settings.accountId}:secret:rds!db-`)) throw new Error("Foreign RDS managed-secret identity");
        if (responses["rds-secret"] && responses["rds-secret"].SecretArn !== secretArn) throw new Error("RDS managed-secret identity drift");
        responses["rds-secret"] = journal.responses["rds-secret"] = { SecretArn: secretArn };
        await save();
      }
    }
    if (c.id === "dns-create") {
      const id = record(out.HostedZone).Id;
      if (typeof id !== "string" || !/^\/hostedzone\/Z[A-Z0-9]+$/.test(id)) throw new Error("Invalid DNS identity");
      journal.responses[c.id] = { HostedZone: { Id: id } };
      await save();
    }
    return out;
  };
  const available = async (c: Call): Promise<boolean> => {
    try {
      const response = await call(c);
      if (c.command === "GetHostedZone" && (record(response.HostedZone).Name !== `zenith-${plan.settings.runId}.invalid.` || record(response.HostedZone).CallerReference !== plan.settings.runId)) throw new Error("DNS resource identity does not match owned plan");
      return !absent(c, response);
    } catch (error) { if (missing(error)) return false; throw error; }
  };
  const discoverDns = async () => {
    if (responses["dns-create"]) return;
    const result = await call(plan.preflight.find(c => c.id === "dns-discover")!);
    const found = rows(result.HostedZones).filter(z => z.Name === `zenith-${plan.settings.runId}.invalid.`);
    if (found.length > 1) throw new Error("Ambiguous DNS identity");
    if (found.length === 1) {
      const id = found[0].Id;
      if (typeof id !== "string" || !/^\/hostedzone\/Z[A-Z0-9]+$/.test(id)) throw new Error("Invalid DNS discovery identity");
      responses["dns-create"] = journal.responses["dns-create"] = { HostedZone: { Id: id } };
      await save();
    }
  };
  try {
    // Identity and marker are required for cleanup as well as execution.
    cleanup = !!options.cleanupOnly;
    const identity = await call(plan.preflight[0]);
    if (identity.Account !== plan.settings.accountId || typeof identity.Arn !== "string" || !identity.Arn.startsWith(`arn:aws:sts::${plan.settings.accountId}:assumed-role/ZenithLiveAcceptance/`)) throw new Error("Wrong account or sandbox execution role");
    if (record((await call(plan.preflight[1])).Parameter).Value !== "true") throw new Error("Sandbox opt-in marker absent");
    if (options.cleanupOnly && journal.attempted.length && record((await call(plan.preflight.find(c => c.id === "run-claim-read")!)).Parameter).Value !== plan.settings.runId) throw new Error("Account run receipt unavailable; cleanup authority unproven");
    if (!options.cleanupOnly) {
      const network = rows((await call(plan.preflight.find(c => c.id === "db-network")!)).DBSubnetGroups);
      const groups = rows((await call(plan.preflight.find(c => c.id === "db-security")!)).SecurityGroups);
      if (network.length !== 1 || groups.length !== 1 || network[0].VpcId !== groups[0].VpcId || rows(network[0].Subnets).length < 2 || rows(groups[0].IpPermissions).length !== 0 || !rows(groups[0].Tags).some(t => t.Key === "zenith:bootstrap" && t.Value === "live-sandbox")) throw new Error("Private owned DB network proof missing");
      const inventory = plan.preflight.find(c => c.id === "prior-leaks")!;
      let page: string | undefined;
      do {
        // Pagination changes only the bounded read input; permissions bind its
        // resource and maximum calls, not the provider-issued opaque page token.
        guard.consume(inventory); await save();
        const out = await transport.send(inventory, { ...inventory.input, ...(page ? { PaginationToken: page } : {}) }, options.signal);
        if (!inventoryEmpty(out.ResourceTagMappingList)) throw new Error("Prior live-acceptance leaks require owner recovery before a new run");
        page = typeof out.PaginationToken === "string" && out.PaginationToken ? out.PaginationToken : undefined;
      } while (page);
      for (const c of plan.preflight.filter(c => c.id.endsWith("-preexist"))) if (await available(c)) throw new Error("Planned resource already exists; refusing adoption/mutation");
      await discoverDns();
      if (responses["dns-create"]) throw new Error("Planned DNS zone already exists");
      // Atomic, account-side no-overwrite claim. A new directory or another
      // machine cannot reset the budget and rerun this same approved run ID.
      await call(plan.preflight.find(c => c.id === "run-claim")!);
      if (record((await call(plan.preflight.find(c => c.id === "run-claim-read")!)).Parameter).Value !== plan.settings.runId) throw new Error("Account run receipt readback failed");
      for (const fixture of [...teardownOrder(plan.fixtures)].reverse()) {
        journal.attempted.push(fixture.family); await save();
        for (const c of fixture.setup) {
          for (let attempt = 0; ; attempt++) {
            try { await call(c); break; } catch (error) {
              if (c.id !== "lambda-create" || record(error).name !== "InvalidParameterValueException" || attempt >= c.maximumCalls - 1) throw error;
              await io.sleep(5000);
            }
          }
        }
        for (const c of fixture.observe) {
          for (let attempt = 0; ; attempt++) {
            const out = await call(c);
            if (c.id !== "lambda-ready" && c.id !== "rds-ready") break;
            const state = c.id === "lambda-ready" ? out.State : rows(out.DBInstances)[0]?.DBInstanceStatus;
            if (state === "Active" || state === "available") break;
            if (state === "Failed" || state === "failed" || attempt >= c.maximumCalls - 1) throw new Error("Provider readiness failed");
            await io.sleep(5000);
          }
        }
        if (!owned(await call(fixture.ownership), plan) || !checkReadback(fixture.family, responses, plan)) throw new Error(`Independent ${fixture.family} readback failed`);
        add({ id: fixture.family, status: "passed", scope: "aws_fixture", reason: fixture.family === "ecs" ? "Owned empty cluster readback only; no managed substrate/traffic proof" : fixture.family === "dns" ? "Owned reserved .invalid TXT readback only; no public DNS/TLS proof" : "Actual provider readback; product acceptance remains separate" });
      }
      for (const requirement of plan.requirements) {
        const result = options.product ? await options.product.verify(requirement, { plan, commit: journal.commit, call }) : { complete: false, reason: requirement.join };
        add({ id: requirement.id, status: result.complete ? "passed" : "pending", scope: "product_requirement", reason: result.reason });
      }
    }
  } catch {
    // Raw exceptions can contain secrets or entire requests; record a fixed
    // failure, keeping service debugging outside the sanitized public packet.
    add({ id: "execution", status: "failed", scope: "aws_fixture", reason: "Execution/preflight refused or failed; no complete acceptance claim" });
  } finally {
    cleanup = true;
    cleanupStarted = io.now().getTime();
    let cleanupFailed = false;
    const blocked = new Set<Family>();
    // A failed identity preflight grants no deletion authority. A successful
    // first read alone is insufficient; marker must also be authentic.
    const authorized = responses.identity?.Account === plan.settings.accountId && typeof responses.identity?.Arn === "string" && responses.identity.Arn.startsWith(`arn:aws:sts::${plan.settings.accountId}:assumed-role/ZenithLiveAcceptance/`) && record(responses.marker?.Parameter).Value === "true" && (!journal.attempted.length || record(responses["run-claim-read"]?.Parameter).Value === plan.settings.runId);
    if (authorized) {
      await teardownUntilFailure(teardownOrder(plan.fixtures).filter(f => journal.attempted.includes(f.family)), async fixture => {
        try {
          if (blocked.has(fixture.family)) throw new Error("Dependent resource not cleared");
          if (fixture.family === "dns") await discoverDns();
          if (fixture.family === "dns" && !responses["dns-create"]) return true;
          if (!await available(fixture.leak[0])) return true;
          if (fixture.family === "rds") {
            for (let attempt = 0; !responses["rds-secret"] && attempt < 179; attempt++) {
              await io.sleep(5000); await available(fixture.leak[0]);
            }
            if (!responses["rds-secret"]) throw new Error("Managed secret identity unproven before DB teardown");
          }
          if (!owned(await call(fixture.ownership), plan)) throw new Error("Ownership tags missing; refusing deletion");
          for (const c of fixture.teardown) {
            for (let attempt = 0; ; attempt++) {
              try { await call(c); break; } catch (error) {
                if (missing(error)) break;
                // DELETE TXT after partial setup: InvalidChangeBatch is NOT
                // silently swallowed, because it can mean unrelated DNS drift.
                if (!["InvalidDBInstanceStateFault", "HostedZoneNotEmpty", "DeleteConflictException"].includes(record(error).name as string) || attempt >= c.maximumCalls - 1) throw error;
                await io.sleep(5000);
              }
            }
          }
          const leak = fixture.leak[0];
          let cleared = false;
          for (let attempt = 0; attempt < leak.maximumCalls - 1; attempt++) {
            if (!await available(leak)) { cleared = true; break; }
            await io.sleep(5000);
          }
          if (!cleared) throw new Error("Leak scan did not prove deletion");
          for (const extra of fixture.leak.slice(1)) {
            let absent = false;
            for (let attempt = 0; attempt < extra.maximumCalls; attempt++) {
              if (!await available(extra)) { absent = true; break; }
              await io.sleep(5000);
            }
            if (!absent) throw new Error("Dependent resource absence unproven");
          }
          add({ id: fixture.family, status: "passed", scope: "cleanup", reason: "Ownership checked and native provider absence observed" });
        } catch {
          cleanupFailed = true;
          add({ id: fixture.family, status: "failed", scope: "cleanup", reason: "Cleanup/ownership/absence proof failed; resources may still bill. Resume owned journal; no unrelated sweep." });
          fixture.dependsOn.forEach(f => blocked.add(f));
        }
        await save();
        return !blocked.has(fixture.family);
      }, false); // Independent fixtures continue; the existing dependency blocklist refuses their parents.
    } else if (journal.attempted.length) { cleanupFailed = true; add({ id: "authority", status: "failed", scope: "cleanup", reason: "Authentic sandbox authority unavailable; cleanup refused" }); }
    journal.closed = authorized && !cleanupFailed;
    await save();
  }
  return journal;
}
