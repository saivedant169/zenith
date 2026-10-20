/**
 * Static checks on the PROD-MAN-01 local acceptance harness (scripts/k8s/managed-substrate-acceptance.sh and
 * scripts/managed/seed-platform-vault.ts). No cluster, no docker. They pin the properties that make the harness
 * safe to run: it can only ever touch its own disposable cluster, it refuses unpinned images, it never prints the
 * operator credential, and the gated test is skipped, never counted as passed, without its prerequisites.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main as seed } from "../../../scripts/managed/seed-platform-vault";

const root = path.resolve(__dirname, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), "utf8");
const script = read("scripts/k8s/managed-substrate-acceptance.sh");

describe("managed-substrate-acceptance.sh", () => {
  it("stops on the first error and unset variable, and can only name its own cluster", () => {
    expect(script).toMatch(/^set -euo pipefail$/m);
    expect(script).toContain('name="$(k8s_cluster_name)"');
    expect(script).toContain('ZENITH_KIND_CLUSTER_NAME="${ZENITH_KIND_CLUSTER_NAME:-zenith-life07-man01}"');
  });

  it("refuses an image that is not pinned by digest, and pins none of its own it has not read", () => {
    expect(script).toContain("ZENITH_MAN_REGISTRY_IMAGE");
    expect(script).toContain("ZENITH_MAN_BUILDER_IMAGE");
    expect(script).toContain("pinned image");
    expect(script).toContain("@sha256:[a-f0-9]{64}$");
    expect(script).not.toMatch(/sha256:[a-f0-9]{64}/);
  });

  it("deletes the cluster on every exit unless asked to keep it", () => {
    expect(script).toContain("trap cleanup EXIT");
    expect(script).toContain("kind-calico-down.sh");
    expect(script).toContain('ZENITH_K8S_KEEP:-0}" != "1"');
  });

  it("seals the operator credential into the platform vault with the operator tool, then deletes the file, and never prints it", () => {
    expect(script).toContain("scripts/managed/seed-platform-vault.ts --ref vault:zenith-managed/kubeconfig --file");
    expect(script).toContain('rm -f "$secrets_dir/operator-token"');
    expect(script).toContain("umask 077");
    expect(script).not.toMatch(/echo[^\n]*operator-token/);
    expect(script).not.toMatch(/cat[^\n]*operator-token/);
  });

  it("uses ingress mode (no Gateway API or cert-manager is installed) and extends the build egress by the registry namespace only", () => {
    expect(script).toContain("ZENITH_MANAGED_GATEWAY_MODE=ingress");
    expect(script).toContain("kubernetes.io/metadata.name: zenith-registry");
    expect(script).not.toContain("0.0.0.0/0");
  });

  it("runs only the gated managed test", () => {
    expect(script).toContain("tests/providers/zenith/managed-kind.test.ts");
    expect(script).toContain("ZENITH_TEST_MANAGED_KIND=1");
  });
});

describe("the gated managed-kind test", () => {
  const test = read("tests/providers/zenith/managed-kind.test.ts");
  it("skips with a stated reason, and never counts a skipped run as passed", () => {
    expect(test).toContain("describe.skipIf(!enabled)");
    expect(test).toContain("managed-kind acceptance skipped:");
  });
  it("builds the substrate through the default composition, injecting nothing but the control-plane lookup and platform database", () => {
    expect(test).toContain("createDefaultManagedSubstrate({ env: { ...process.env }, product, db: lane.db })");
    expect(test).not.toContain("createKubernetesSession");
    expect(test).not.toContain("readPlatformSecret");
    expect(test).not.toContain("operatorCredentialBackend");
  });
});

describe("seed-platform-vault", () => {
  it("is a usage error without both flags, a vault reference and a file", async () => {
    const out: string[] = [];
    expect(await seed([], {}, (l) => out.push(l))).toBe(2);
    expect(await seed(["--ref", "not-a-vault-ref", "--file", "x"], {}, (l) => out.push(l))).toBe(2);
    expect(await seed(["--ref", "vault:a/b", "--ref", "vault:a/c", "--file", "x"], {}, (l) => out.push(l))).toBe(2);
    expect(out.join("\n")).toContain("Usage:");
  });

  it("fails without echoing the cause when the file cannot be read", async () => {
    const out: string[] = [];
    const code = await seed(["--ref", "vault:zenith-managed/kubeconfig", "--file", path.join(root, "definitely-not-a-file-xyz")], {}, (l) => out.push(l));
    expect(code).toBe(1);
    expect(out.join("\n")).toBe("failed: the value could not be written");
    expect(out.join("\n")).not.toContain("definitely-not-a-file-xyz");
  });

  it("takes the value from a file or stdin, never from an argument", () => {
    const src = read("scripts/managed/seed-platform-vault.ts");
    expect(src).toContain('flag !== "--ref" && flag !== "--file"');
    expect(src).not.toContain("--value");
  });
});
