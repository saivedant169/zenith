/**
 * PROD-DUR-06: the GCS state adapter against a REAL GCS-API server (fsouza/fake-gcs-server) in an owned, disposable
 * container. Gated by ZENITH_TEST_GCS=1. The store is built through gcsStoreFromSession, the production entry point, and
 * its session's authorizedFetch is the only transport. The module hard-codes https://storage.googleapis.com, so the
 * transport rewrites ONLY the origin to the container at 127.0.0.1, after asserting the module asked for that origin.
 * Paths, query strings, preconditions and bodies are the module's own. Where the server lacks a feature the adapter
 * needs, that case is skipped with the server response recorded; it is not simulated. No DELETE request is ever sent.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gcsStoreFromSession } from "@/lib/tofu/state-backend-gcs";
import type { StateBackendStore } from "@/lib/tofu/state-backend-s3";

// fsouza/fake-gcs-server, digest-pinned. Resolved from the :latest tag on 2026-10-21 (RepoDigests).
const DEFAULT_FAKE_GCS_IMAGE = "fsouza/fake-gcs-server@sha256:797ce226d62f947c009dc40246b30cfb456b8473d8241407f9d6f2c04e4d69ef";
const GCS_ORIGIN = "https://storage.googleapis.com";
const DOCKER = process.env.ZENITH_TEST_DOCKER ?? "docker";
const PORT = Number(process.env.ZENITH_TEST_GCS_PORT ?? 55460);
const CONTAINER_PORT = 4443;
const BASE = `zenith/ws_1/env_${randomBytes(3).toString("hex")}`;
const KEY_MAIN = `${BASE}/main/terraform.tfstate`;
const KEY_RACE = `${BASE}/race/terraform.tfstate`;
const KEY_LOCK = `${BASE}/lock/terraform.tfstate`;
const KEY_CMEK = `${BASE}/cmek/terraform.tfstate`;
// The GCS adapter names its lock object `<state without .tfstate>.tflock`; the test uses the same name.
const LOCK_OBJECT = `${KEY_LOCK.replace(/\.tfstate$/, "")}.tflock`;

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const bytesOf = (serial: number) => Buffer.from(`{"serial":${serial}}`);

let container: string | undefined;
let endpoint = "";
let versionedBucket = "";
let unversionedBucket = "";
// "METHOD /path" for every request the suite sends, adapter and test setup alike. Query strings are not recorded.
const requests: string[] = [];

function docker(args: string[]): string {
  return execFileSync(DOCKER, args, { encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Test setup talks to the server directly (bucket and object creation, precondition probes). */
async function admin(method: string, path: string, body?: Buffer | string, headers: Record<string, string> = {}): Promise<Response> {
  requests.push(`${method} ${path.split("?")[0]}`);
  return fetch(`${endpoint}${path}`, { method, body: body === undefined ? undefined : new Uint8Array(Buffer.from(body)), headers, redirect: "error" });
}

/**
 * The session the production broker hands out: authorizedFetch is the only transport the adapter uses. `beforeRequest`
 * lets one case inject a concurrent writer at an exact point, after the adapter's own check and before its upload.
 */
function session(beforeRequest?: (method: string, pathname: string) => Promise<void>) {
  return {
    authorizedFetch: async (url: string, init?: RequestInit): Promise<Response> => {
      const asked = new URL(url);
      if (asked.origin !== GCS_ORIGIN) throw new Error(`the adapter asked for ${asked.origin}, not ${GCS_ORIGIN}`);
      const method = init?.method ?? "GET";
      requests.push(`${method} ${asked.pathname}`);
      await beforeRequest?.(method, asked.pathname);
      return fetch(`${endpoint}${asked.pathname}${asked.search}`, init);
    },
  };
}

function store(bucket: string, key: string, beforeRequest?: (method: string, pathname: string) => Promise<void>): StateBackendStore {
  return gcsStoreFromSession(session(beforeRequest), { kind: "gcs", bucket, prefix: BASE }, key);
}

async function waitHealthy(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if ((await fetch(`${endpoint}/storage/v1/b?project=zenith-test`)).ok) return; } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error("fake-gcs-server did not become healthy in time");
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

async function createBucket(name: string, versioned: boolean): Promise<void> {
  const res = await admin("POST", "/storage/v1/b", JSON.stringify({ name, ...(versioned ? { versioning: { enabled: true } } : {}) }), { "content-type": "application/json" });
  if (!res.ok) throw new Error(`bucket ${name} was not created: HTTP ${res.status}`);
  await res.body?.cancel();
}

/** Uploads an object. `precondition` is ifGenerationMatch: "0" means create only if absent. Returns the response. */
async function upload(bucket: string, key: string, body: Buffer, precondition?: string, extra: Record<string, string> = {}): Promise<Response> {
  const q = new URLSearchParams({ uploadType: "media", name: key, fields: "generation", ...extra });
  if (precondition !== undefined) q.set("ifGenerationMatch", precondition);
  return admin("POST", `/upload/storage/v1/b/${bucket}/o?${q}`, body, { "content-type": "application/json" });
}

async function put(bucket: string, key: string, body: Buffer): Promise<string> {
  const res = await upload(bucket, key, body);
  if (!res.ok) throw new Error(`upload of ${key} failed: HTTP ${res.status}`);
  return String((await res.json() as { generation: unknown }).generation);
}

async function generationOf(bucket: string, key: string): Promise<string> {
  const res = await admin("GET", `/storage/v1/b/${bucket}/o/${encodeURIComponent(key)}?fields=generation`);
  return String((await res.json() as { generation: unknown }).generation);
}

describe.skipIf(process.env.ZENITH_TEST_GCS !== "1")("GCS state adapter against fake-gcs-server", () => {
  let v1 = "";
  let v1Etag = "";

  beforeAll(async () => {
    const image = process.env.ZENITH_TEST_GCS_IMAGE || DEFAULT_FAKE_GCS_IMAGE;
    if (!Number.isInteger(PORT) || PORT < 55460 || PORT > 55469) throw new Error("the test port must be within 55460-55469.");
    const name = `zenith-gcs-test-${randomBytes(4).toString("hex")}`;
    docker(["run", "-d", "--name", name, "-p", `127.0.0.1:${PORT}:${CONTAINER_PORT}`, image,
      "-scheme", "http", "-port", String(CONTAINER_PORT), "-backend", "memory", "-external-url", `http://127.0.0.1:${PORT}`]);
    container = name;
    endpoint = `http://127.0.0.1:${PORT}`;
    await waitHealthy(120_000);
    versionedBucket = `zenith-gcs-v-${randomBytes(4).toString("hex")}`;
    unversionedBucket = `zenith-gcs-u-${randomBytes(4).toString("hex")}`;
    await createBucket(versionedBucket, true);
    await createBucket(unversionedBucket, false);
    // v1 of the main state object: written by the test setup, before the adapter is involved.
    v1 = await put(versionedBucket, KEY_MAIN, bytesOf(1));
    v1Etag = await generationOf(versionedBucket, KEY_MAIN);
  }, 180_000);

  afterAll(() => {
    if (container) docker(["rm", "-f", container]);
  });

  it("admission: a versioned bucket is restore-ready at the current generation; an unversioned one is refused", async () => {
    const ready = await store(versionedBucket, KEY_MAIN).probe();
    expect(ready).toMatchObject({ backendKind: "gcs", versioning: "enabled", encryption: "sse_s3", lockObject: "absent", currentVersionId: v1, restoreReady: true, refusals: [] });

    await put(unversionedBucket, KEY_MAIN, bytesOf(1));
    const refused = await store(unversionedBucket, KEY_MAIN).probe();
    expect(refused).toMatchObject({ versioning: "disabled", encryption: "sse_s3", restoreReady: false });
    expect(refused.refusals).toEqual(["Bucket versioning is disabled."]);
  });

  it("generation precondition: the current generation succeeds as v2; a stale generation is refused and v2 stays current", async () => {
    const s = store(versionedBucket, KEY_MAIN);
    const written = await s.writeRestored(bytesOf(2), { currentEtag: v1Etag });
    expect(written.versionId).not.toBe(v1);
    await expect(s.writeRestored(bytesOf(3), { currentEtag: v1Etag })).rejects.toMatchObject({ code: "state_changed" });
    const current = await s.readCurrent();
    expect(current.versionId).toBe(written.versionId);
    expect(current.bytes.equals(bytesOf(2))).toBe(true);
  });

  it("server-side ifGenerationMatch: a write that loses a race after the adapter's check is refused by the server, not the adapter", async () => {
    const etag = await put(versionedBucket, KEY_RACE, bytesOf(1));
    // A concurrent writer lands between the adapter's metadata check and its upload, so only ifGenerationMatch can refuse it.
    let raced = false;
    const racing = store(versionedBucket, KEY_RACE, async (method, pathname) => {
      if (!raced && method === "POST" && pathname.startsWith("/upload/")) {
        raced = true;
        await put(versionedBucket, KEY_RACE, bytesOf(9));
      }
    });
    await expect(racing.writeRestored(bytesOf(2), { currentEtag: etag })).rejects.toMatchObject({ code: "state_changed" });
    expect(raced).toBe(true);
    expect((await racing.readCurrent()).bytes.equals(bytesOf(9))).toBe(true);
  });

  it("lists both generations and reads v1 with its sha256", async () => {
    const s = store(versionedBucket, KEY_MAIN);
    const versions = await s.listVersions(10);
    expect(versions.map(v => v.versionId)).toHaveLength(2);
    expect(versions.find(v => v.versionId === v1)).toMatchObject({ isLatest: false });
    expect(versions.filter(v => v.isLatest)).toHaveLength(1);
    const read = await s.readVersion(v1);
    expect(read.bytes.equals(bytesOf(1))).toBe(true);
    expect(read.sha256).toBe(sha(bytesOf(1)));
  });

  it("restore of v1 writes a NEW current generation equal to v1; v2 remains as a noncurrent generation", async () => {
    const s = store(versionedBucket, KEY_MAIN);
    const earlier = await s.readVersion(v1);
    const current = await s.readCurrent();
    const restored = await s.writeRestored(earlier.bytes, { currentEtag: current.etag ?? "" });
    const readback = await s.readCurrent();
    expect(readback.versionId).toBe(restored.versionId);
    expect(readback.sha256).toBe(earlier.sha256);

    const versions = await s.listVersions(10);
    expect(versions).toHaveLength(3);
    expect(versions.filter(v => v.isLatest).map(v => v.versionId)).toEqual([restored.versionId]);
    expect(versions.filter(v => !v.isLatest).map(v => v.versionId)).toContain(current.versionId);
    expect((await s.readVersion(current.versionId)).bytes.equals(bytesOf(2))).toBe(true);
  });

  it("lock: a second holder of the create-only lock object is refused, and the probe refuses restore while it is held", async () => {
    await put(versionedBucket, KEY_LOCK, bytesOf(1));
    const first = await upload(versionedBucket, LOCK_OBJECT, Buffer.from("holder-a"), "0");
    expect(first.ok).toBe(true);
    await first.body?.cancel();
    const second = await upload(versionedBucket, LOCK_OBJECT, Buffer.from("holder-b"), "0");
    expect(second.status).toBe(412);
    await second.body?.cancel();
    const verdict = await store(versionedBucket, KEY_LOCK).probe();
    expect(verdict).toMatchObject({ lockObject: "present", restoreReady: false });
  });

  it("encryption: a CMEK object is reported as sse_kms; skipped, with the server response, when the server does not store kmsKeyName", async ({ skip }) => {
    const kmsKeyName = "projects/zenith-test/locations/us/keyRings/zenith/cryptoKeys/state";
    await put(versionedBucket, KEY_CMEK, bytesOf(1));
    const up = await upload(versionedBucket, KEY_CMEK, bytesOf(2), undefined, { kmsKeyName });
    expect(up.ok).toBe(true);
    await up.body?.cancel();
    const meta = await (await admin("GET", `/storage/v1/b/${versionedBucket}/o/${encodeURIComponent(KEY_CMEK)}?fields=generation,kmsKeyName`)).json() as Record<string, unknown>;
    if (meta.kmsKeyName !== kmsKeyName) skip(`fake-gcs-server does not store kmsKeyName: upload HTTP 200, metadata ${JSON.stringify(meta)}`);
    expect((await store(versionedBucket, KEY_CMEK).probe()).encryption).toBe("sse_kms");
  });

  it("never sends a DELETE across the whole suite", () => {
    expect(requests.some(r => r.startsWith("POST /upload/"))).toBe(true);
    expect(requests.filter(r => r.startsWith("DELETE"))).toEqual([]);
  });
});
