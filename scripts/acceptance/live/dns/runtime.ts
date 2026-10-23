import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve as resolveDns } from "node:dns/promises";
import { connect } from "node:tls";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { HttpControlPlaneClient, isTerminalStatus } from "../../clients/control-plane";
import { CASES, gcpInventoryItemsPointer, isCompleteGcpInventoryUrl, type Assertion, type Inventory, type Packet, type Probe } from "./contracts";
import { digest, Guard } from "./guard";
import { verifyMixedEvidence } from "../../mixed-evidence";
import { tagsMatch, teardownUntilFailure } from "../shared";

const Credentials = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("azure"), account: z.string(), region: z.string(), tokenFiles: z.record(z.string(), z.string().min(1)), trafficTokenFiles: z.record(z.string(), z.string().min(1)).optional() }).strict(),
  z.object({ provider: z.literal("gcp"), account: z.string(), region: z.string(), accessTokenFile: z.string().min(1), trafficTokenFiles: z.record(z.string(), z.string().min(1)).optional() }).strict(),
  z.object({ provider: z.literal("oci"), account: z.string(), region: z.string(), securityTokenFile: z.string().min(1), privateKeyFile: z.string().min(1), trafficTokenFiles: z.record(z.string(), z.string().min(1)).optional() }).strict(),
]);
type Credentials = z.infer<typeof Credentials>;
export type ReadResult = { body: unknown; nextPage?: string };
export interface Port {
  readCloud(url: string): Promise<ReadResult>;
  readControl(path: string): Promise<unknown>;
  traffic(url: string, nonce: string): Promise<unknown>;
  dns(name: string, type: "TXT" | "A" | "AAAA" | "CNAME"): Promise<string[]>;
  tls(url: string, minValidityHours: number): Promise<void>;
  teardown(environmentId: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

const MISSING = Symbol("missing");
export function pointer(value: unknown, path: string): unknown {
  if (path === "") return value;
  if (!path.startsWith("/")) throw new Error("Invalid JSON pointer");
  let result = value;
  for (const key of path.slice(1).split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (!result || typeof result !== "object" || !Object.hasOwn(result, key)) return MISSING;
    result = (result as Record<string, unknown>)[key];
  }
  return result;
}
export function assertReadback(body: unknown, assertions: z.infer<typeof Assertion>[]) {
  const equal = (value: unknown, expected: unknown) => Array.isArray(expected)
    ? Array.isArray(value) && value.length === expected.length && value.every((v, i) => Object.is(v, expected[i]))
    : Object.is(value, expected);
  for (const a of assertions) {
    const value = pointer(body, a.pointer);
    const ok = a.operator === "absent" ? value === MISSING
      : a.operator === "equals" ? value !== MISSING && equal(value, a.expected)
      : a.operator === "contains" ? Array.isArray(value) && value.some((v) => equal(v, a.expected))
      : typeof value === "string" ? value.length > 0 : Array.isArray(value) && value.length > 0;
    if (!ok) throw new Error("Independent readback assertion failed");
  }
}
async function jsonResponse(response: Response): Promise<ReadResult> {
  if (!response.ok) { await response.body?.cancel(); throw new Error("Live read failed"); }
  if (!response.body) throw new Error("Live read has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error("Live read exceeds bounded response size");
      chunks.push(value);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (/^(?:application|text)\/xml\b/.test(response.headers.get("content-type") ?? ""))
      return { body: { httpStatus: response.status, contentSha256: digest(text) } };
    return { body: JSON.parse(text), nextPage: response.headers.get("opc-next-page") ?? undefined };
  } finally { await reader.cancel().catch(() => undefined); }
}

// Called only after gate + permission validation. --plan never enters this function.
export function livePort(guard: Guard, credentialFile: string, tokenFile: string, log: (s: string) => void): Port {
  guard.check();
  const credentials: Credentials = Credentials.parse(JSON.parse(readFileSync(credentialFile, "utf8")));
  if (credentials.provider !== guard.packet.provider || credentials.account !== guard.packet.account || credentials.region !== guard.packet.region)
    throw new Error("Credential target does not match reviewed packet");
  const token = readFileSync(tokenFile, "utf8").trim();
  if (!token) throw new Error("Control-plane credential file is empty");
  const guardedFetch: typeof fetch = (input, init) => {
    const url = guard.url(String(input), "control");
    const method = init?.method ?? "GET";
    if (method !== "GET" && !(method === "POST" && url.pathname.endsWith("/teardown-review"))) throw new Error("Live mutation endpoint refused");
    return fetch(url, { ...init, redirect: "error" });
  };
  const cp = new HttpControlPlaneClient({ baseUrl: guard.packet.apiOrigin, workspaceId: guard.packet.workspaceId, token, fetch: guardedFetch });
  return {
    async readCloud(raw) {
      const url = guard.url(raw, "cloud");
      const headers: Record<string, string> = { accept: "application/json" };
      if (credentials.provider === "oci") {
        const date = new Date().toUTCString();
        const session = readFileSync(credentials.securityTokenFile, "utf8").trim();
        const key = readFileSync(credentials.privateKeyFile, "utf8");
        if (!session || /["\r\n]/.test(session)) throw new Error("Invalid short-lived OCI session file");
        const signing = `date: ${date}\n(request-target): get ${url.pathname}${url.search}\nhost: ${url.host}`;
        const signature = createSign("RSA-SHA256").update(signing).sign(key, "base64");
        headers.date = date;
        headers.authorization = `Signature version="1",keyId="ST$${session}",algorithm="rsa-sha256",headers="date (request-target) host",signature="${signature}"`;
      } else {
        const file = credentials.provider === "azure" ? credentials.tokenFiles[url.origin] : credentials.accessTokenFile;
        if (!file) throw new Error("No audience-specific Azure token FILE configured");
        const access = readFileSync(file, "utf8").trim();
        if (!access || /[\r\n]/.test(access)) throw new Error("Invalid short-lived token file");
        headers.authorization = `Bearer ${access}`;
        if (credentials.provider === "azure" && url.hostname.includes(".blob.")) headers["x-ms-version"] = "2023-11-03";
      }
      return jsonResponse(await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) }));
    },
    async readControl(path) {
      const url = guard.url(new URL(path, guard.packet.apiOrigin).href, "control");
      return (await jsonResponse(await guardedFetch(url, { headers: { authorization: `Bearer ${token}`, "x-zenith-workspace": guard.packet.workspaceId }, signal: AbortSignal.timeout(30_000) }))).body;
    },
    async traffic(raw, nonce) {
      const url = guard.url(raw, "traffic");
      url.searchParams.set("zenith_acceptance_nonce", nonce);
      const headers: Record<string, string> = { accept: "application/json" };
      const file = credentials.trafficTokenFiles?.[url.origin];
      if (file) {
        const bearer = readFileSync(file, "utf8").trim();
        if (!bearer || /[\r\n]/.test(bearer)) throw new Error("Invalid traffic token FILE");
        headers.authorization = `Bearer ${bearer}`;
      }
      // Real fixture must write then independently read the supplied nonce. GET is side-effect-free
      // for other paths; the reviewed packet selects the acceptance fixture's protected endpoint.
      return (await jsonResponse(await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) }))).body;
    },
    async dns(name, type) {
      guard.dns(name);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const results = await Promise.race([
          resolveDns(name, type),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("DNS acceptance timed out")), 30_000); }),
        ]);
        return (results as (string | string[])[]).map((v) => Array.isArray(v) ? v.join("") : v).sort();
      } finally { if (timer) clearTimeout(timer); }
    },
    async tls(raw, minValidityHours) {
      const url = guard.url(raw, "traffic");
      await new Promise<void>((resolve, reject) => {
        const socket = connect({ host: url.hostname, port: 443, servername: url.hostname, rejectUnauthorized: true, timeout: 30_000 });
        const fail = () => { socket.destroy(); reject(new Error("TLS trust, hostname or validity check failed")); };
        socket.once("error", fail);
        socket.once("timeout", fail);
        socket.once("secureConnect", () => {
          const expiry = Date.parse(socket.getPeerCertificate().valid_to);
          const ok = socket.authorized && Number.isFinite(expiry) && expiry >= Date.now() + minValidityHours * 3600_000;
          socket.destroy();
          if (ok) resolve(); else fail();
        });
      });
    },
    async teardown(environmentId) {
      guard.check();
      if (!guard.packet.environmentIds.includes(environmentId)) throw new Error("Foreign environment teardown refused");
      const review = await cp.requestTeardownReview(environmentId, `${guard.packet.runId}-cleanup-${environmentId}`);
      let destroyId: string | undefined;
      const deadline = Date.now() + 30 * 60_000;
      while (Date.now() < deadline) {
        const { review: view } = await cp.getTeardownReview(environmentId, review.reviewOperationId);
        if (view?.operationId) { destroyId = view.operationId; break; }
        if (view && isTerminalStatus(view.status)) throw new Error("Teardown review refused or failed");
        await sleep(5000);
      }
      if (!destroyId) throw new Error("Teardown review timed out");
      log(`Human browser approval required for teardown operation ${destroyId}`);
      while (Date.now() < deadline) {
        const view = await cp.getOperation(destroyId);
        if (view.operation.id !== destroyId || view.operation.environmentId !== environmentId || view.operation.capability !== "infrastructure.destroy" || !view.operation.approvalRequired)
          throw new Error("Teardown operation scope or approval binding mismatch");
        if (view.operation.status === "succeeded") {
          if (!view.operation.proposalDigest || !view.approvals.some((a) => a.decision === "approve" && a.consumed === true && a.approverId !== view.operation.principal?.id))
            throw new Error("Teardown human approval receipt unavailable");
          return;
        }
        if (isTerminalStatus(view.operation.status)) throw new Error("Approved teardown did not succeed");
        await sleep(5000);
      }
      throw new Error("Teardown approval or completion timed out");
    },
    sleep: (ms) => sleep(ms),
  };
}

export async function inventory(port: Port, descriptor: Inventory, guard: Guard): Promise<{ id: string; owned: boolean }[]> {
  const all: { id: string; owned: boolean }[] = [];
  const visited = new Set<string>();
  let parent: unknown;
  let url: string | undefined = descriptor.url;
  for (let page = 0; url && page < 100; page++) {
    if (descriptor.pagination === "gcp" && !isCompleteGcpInventoryUrl(url))
      throw new Error("Inventory requires an unprojected, flat list");
    guard.url(url, "cloud");
    if (visited.has(url)) throw new Error("Inventory pagination repeated");
    visited.add(url);
    const result = await port.readCloud(url);
    if (descriptor.pagination === "gcp") {
      const unreachable = pointer(result.body, "/unreachable");
      if (unreachable !== MISSING && (!Array.isArray(unreachable) || unreachable.length !== 0))
        throw new Error("Inventory contains unreachable resources");
    }
    if (descriptor.pagination === "gcp" && pointer(result.body, "/kind") === "storage#objects") {
      const prefixes = pointer(result.body, "/prefixes");
      if (prefixes !== MISSING && (!Array.isArray(prefixes) || prefixes.length !== 0))
        throw new Error("Storage inventory must list objects without collapsed prefixes");
    }
    const rawItems = pointer(result.body, descriptor.itemsPointer);
    const items = rawItems === MISSING && descriptor.pagination === "gcp" && descriptor.itemsPointer === gcpInventoryItemsPointer(descriptor.emptyListKind) && descriptor.emptyListKind && pointer(result.body, "/kind") === descriptor.emptyListKind ? [] : rawItems;
    if (!Array.isArray(items)) throw new Error("Inventory response is unreadable");
    if (items.length && descriptor.parentOwnership && parent === undefined) {
      guard.url(descriptor.parentOwnership.url, "cloud");
      parent = (await port.readCloud(descriptor.parentOwnership.url)).body;
    }
    for (const item of items) {
      const id = pointer(item, descriptor.idPointer);
      const tags = pointer(item, descriptor.tagsPointer);
      if (typeof id === "string" && guard.permissions.retainedResourceIds.includes(id)) continue;
      if (typeof id !== "string" || !id) throw new Error("Inventory identity is unreadable");
      let owned = tagsMatch(tags, { zenith_live_run: guard.packet.runId });
      const p = descriptor.parentOwnership;
      if (p) {
        const parentTags = pointer(parent, p.tagsPointer);
        const parentOwned = tagsMatch(parentTags, { zenith_live_run: guard.packet.runId });
        const matchesId = p.childIdPrefix ? id.startsWith(p.childIdPrefix.endsWith("/") ? p.childIdPrefix : p.childIdPrefix + "/") : true;
        let matchesValues = true;
        if (p.targetValuesPointer !== undefined && p.itemValuesPointer !== undefined) {
          const target = pointer(parent, p.targetValuesPointer);
          const source = pointer(item, p.itemValuesPointer);
          const targetValues = Array.isArray(target) ? target : [target];
          const sourceValues = (Array.isArray(source) ? source : [source]).map((v) => p.itemValuePointer !== undefined ? pointer(v, p.itemValuePointer) : v);
          matchesValues = sourceValues.length > 0 && sourceValues.every((v) => typeof v === "string" && targetValues.includes(v));
        }
        owned = parentOwned && matchesId && matchesValues;
      }
      all.push({ id, owned });
    }
    if (descriptor.pagination === "azure") {
      const next = pointer(result.body, "/nextLink");
      if (next !== MISSING && next !== null && typeof next !== "string") throw new Error("Inventory nextLink is unreadable");
      url = typeof next === "string" && next ? next : undefined;
    } else {
      const next = descriptor.pagination === "gcp" ? pointer(result.body, "/nextPageToken") : result.nextPage;
      if (next !== MISSING && next !== undefined && next !== null && typeof next !== "string") throw new Error("Inventory page token is unreadable");
      if (typeof next === "string" && next) {
        const u = new URL(descriptor.url);
        u.searchParams.set(descriptor.pagination === "gcp" ? "pageToken" : "page", next);
        url = u.href;
      } else url = undefined;
    }
  }
  if (url) throw new Error("Inventory exceeds bounded pagination");
  if (new Set(all.map((x) => x.id)).size !== all.length) throw new Error("Inventory has duplicate resource identities");
  return all.filter((x) => !guard.permissions.retainedResourceIds.includes(x.id));
}

async function probe(port: Port, p: Probe, guard: Guard) {
  if (p.kind === "cloud") { guard.url(p.url, "cloud"); assertReadback((await port.readCloud(p.url)).body, p.assertions); }
  if (p.kind === "control") {
    guard.url(new URL(p.path, guard.packet.apiOrigin).href, "control");
    const body = await port.readControl(p.path);
    const operationId = /^\/api\/platform\/v1\/operations\/([^/]+)$/.exec(p.path)?.[1];
    if (operationId) {
      const operation = pointer(body, "/operation");
      if (!operation || typeof operation !== "object" || pointer(operation, "/id") !== operationId ||
          !["succeeded", "failed", "denied", "cancelled"].includes(String(pointer(operation, "/status"))))
        throw new Error("Operation readback lacks a bound terminal receipt");
      const environment = pointer(operation, "/environmentId");
      if (typeof environment !== "string" || !guard.packet.environmentIds.includes(environment)) throw new Error("Operation environment mismatch");
    }
    if (/\/mixed\/plans\//.test(p.path) && !verifyMixedEvidence(body).ok) throw new Error("Mixed plan lacks complete immutable receipts");
    if (p.path.endsWith("/teardown-review")) {
      const review = pointer(body, "/review");
      if (!review || typeof review !== "object" || typeof pointer(review, "/status") !== "string") throw new Error("Teardown review is unreadable");
    }
    assertReadback(body, p.assertions);
  }
  if (p.kind === "traffic") {
    guard.url(p.url, "traffic");
    const response = await port.traffic(p.url, p.nonce);
    assertReadback(response, [...p.assertions, { pointer: "/nonce", operator: "equals", expected: p.nonce }]);
  }
  if (p.kind === "dns") { guard.dns(p.name); assertReadback(await port.dns(p.name, p.type), [{ pointer: "", operator: "equals", expected: [...p.expected].sort() }]); }
  if (p.kind === "tls") { guard.url(p.url, "traffic"); await port.tls(p.url, p.minValidityHours); }
}

export interface Evidence {
  schema: "zenith.live-cloud-evidence.v1";
  level: "live_sandbox";
  commit: string; packetSha256: string;
  result: "passed_checks" | "failed" | "incomplete";
  environment: string;
  checks: { id: string; requirements: string[]; status: "passed_live" | "failed" | "incomplete" }[];
  cleanup: { attempted: number; succeeded: number; leakScan: "empty" | "leaks" | "unknown" };
  limits: string[];
}
export async function run(packet: Packet, guard: Guard, port: Port, cleanupOnly = false, cancelled = () => false): Promise<Evidence> {
  const checks: Evidence["checks"] = [];
  const cleanup: Evidence["cleanup"] = { attempted: 0, succeeded: 0, leakScan: "unknown" };
  let safeToDestroy = false;
  let initialFailed = false;
  try {
    const initial = (await Promise.all(packet.inventory.map((d) => inventory(port, d, guard)))).flat();
    safeToDestroy = initial.every((x) => x.owned);
    if (!safeToDestroy) throw new Error("Foreign resource in sandbox; automatic cleanup refused");
    if (!cleanupOnly) for (const check of packet.checks) {
      if (cancelled()) throw new Error("Acceptance cancelled");
      guard.check();
      const types = new Set(check.probes.map((p) => p.kind));
      // Refusals are established on the control plane. Positive claims also need independent live reads.
      const refusal = ["dns-foreign", "dns-unreadable", "oci-mysql-refusal", "oci-lost-response"].includes(check.id);
      const independent = types.has("cloud") || types.has("traffic") || types.has("dns") || types.has("tls");
      let status: Evidence["checks"][number]["status"] = "passed_live";
      if (!types.has("control") || (!refusal && !independent) ||
          (check.id === "mixed-traffic" && !types.has("traffic")) ||
          (check.id === "domain-proof-renewal" && (!types.has("dns") || !types.has("tls"))) ||
          (check.id === "azure-sovereign" && !check.probes.some((p) => p.kind === "cloud" && /^management\.(?:usgovcloudapi\.net|chinacloudapi\.cn)$/.test(new URL(p.url).hostname)))) status = "incomplete";
      else {
        try { for (const p of check.probes) { if (cancelled()) throw new Error("Acceptance cancelled"); await probe(port, p, guard); } }
        catch { status = "failed"; }
      }
      checks.push({ id: check.id, requirements: CASES[check.id].requirements, status });
    }
  } catch { initialFailed = true; }
  finally {
    // Never delete directly. The real destroy path revalidates ownership and exact human approval.
    // A failed consumer stops destructive dependency cleanup; every leak scan still runs.
    if (safeToDestroy) cleanup.succeeded = await teardownUntilFailure([...packet.environmentIds].reverse(), async environment => {
      cleanup.attempted++;
      guard.check(); await port.teardown(environment);
      return true;
    });
    try {
      let remaining = -1;
      for (let attempt = 0; attempt < 12; attempt++) {
        const results = await Promise.all(packet.inventory.map((d) => inventory(port, d, guard)));
        remaining = results.flat().length;
        if (remaining === 0) break;
        if (attempt < 11) await port.sleep(5000);
      }
      cleanup.leakScan = remaining === 0 ? "empty" : "leaks";
    } catch { cleanup.leakScan = "unknown"; }
  }
  const incomplete = cleanup.succeeded !== packet.environmentIds.length || cleanup.leakScan !== "empty" || (!cleanupOnly && (checks.length !== packet.checks.length || checks.some((c) => c.status === "incomplete")));
  return {
    schema: "zenith.live-cloud-evidence.v1", level: "live_sandbox", commit: packet.commit, packetSha256: digest(packet),
    result: initialFailed || checks.some((c) => c.status === "failed") ? "failed" : incomplete ? "incomplete" : "passed_checks",
    environment: `${packet.provider}; selected checks; independently queried inventory; human-approved teardown`,
    checks, cleanup,
    limits: ["Selected probes only, never whole-requirement or release verification", "Inventory coverage must include every created family, DNS record, artifact and retained dependency", "SIGKILL, revoked credentials and missing human approval can prevent cleanup; rerun --cleanup with the same packet", "Wave 5 must emit operated fixture packets, including fault-injection chronology and immutable receipt assertions"],
  };
}
