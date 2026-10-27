import { describe, expect, it } from "vitest";
import { ManifestV2 } from "@/lib/resources/manifest-v2";
import { expandManifest } from "@/lib/resources/expand";
import { v2OnlySections } from "@/lib/resources/upgrade";
import template from "../../fixtures/mixed-app/zenith.app.json";
import { referenceCostGraph } from "../../scripts/acceptance/mixed/cost-report";

const bind = () => ({ ...structuredClone(template), functions: [{ ...template.functions[0], source: { type: "s3", bucket: "fixture-artifacts", key: "functions/enricher.zip", version: "immutable-1", sha256: "a".repeat(64), sourceDigest: "b".repeat(64) } }] });
describe("experimental manifest Lambda binding", () => {
  it("emits a function and invocation dependency rather than a container stand-in", () => {
    const m = ManifestV2.parse(bind());
    const graph = expandManifest(m, { id: "mixed", name: "mixed", class: "production", provider: "gcp", region: "us-central1", baseDomain: "mixed.example.test" });
    const fn = graph.nodes.find(n => n.address === "function/enricher")!;
    expect(fn).toMatchObject({ kind: "function", nativeType: "aws:lambda_function", provider: "aws", spec: { handler: "enricher/handler.handler", artifact: { version: "immutable-1", sha256: "a".repeat(64), sourceDigest: "b".repeat(64) } } });
    expect(graph.nodes.some(n => n.address === "container_service/enricher")).toBe(false);
    expect(graph.nodes.find(n => n.address === "container_service/web")?.dependsOn).toContain(fn.address);
    expect(graph.edges.some(e => e.from === "container_service/web" && e.to === fn.address)).toBe(true);
    expect(v2OnlySections(m)).toContain("functions");
    expect(referenceCostGraph().nodes.find(n => n.address === "function/enricher")?.kind).toBe("function");
  });
  it.each([undefined, "", "null"])("refuses a mutable S3 version %s", version => {
    const m = bind(); Object.assign(m.functions[0].source, { version });
    expect(ManifestV2.safeParse(m).success).toBe(false);
  });
  it.each(["sha256", "sourceDigest"])("refuses absent or non-digest %s", field => {
    const m = bind(); Object.assign(m.functions[0].source, { [field]: "main" });
    expect(ManifestV2.safeParse(m).success).toBe(false);
  });
  it("refuses conflicting placement, unknown invoking services and inline credentials", () => {
    const m = bind(); m.functions[0].invokedBy = ["foreign"];
    expect(ManifestV2.safeParse(m).success).toBe(false);
    m.functions[0].invokedBy = ["web"];
    Object.assign(m.nodePlacement, { enricher: { provider: "gcp", region: "us-central1" } });
    expect(ManifestV2.safeParse(m).success).toBe(false);
    delete (m.nodePlacement as Record<string, unknown>).enricher;
    Object.assign(m.functions[0], { env: [{ key: "API_TOKEN", value: Array.from({ length: 30 }, () => "x").join("") }] });
    expect(ManifestV2.safeParse(m).success).toBe(false);
  });
  it("orders a function after the resources it names in dependsOn and drops one this manifest lacks", () => {
    const m = bind(); const resource = m.resources[0]!;
    Object.assign(m.functions[0], { dependsOn: [resource.id, "absent"] });
    const graph = expandManifest(ManifestV2.parse(m), { id: "mixed", name: "mixed", class: "production", provider: "gcp", region: "us-central1", baseDomain: "mixed.example.test" });
    const fn = graph.nodes.find(n => n.address === "function/enricher")!;
    expect(fn.dependsOn).toHaveLength(1);
    expect(graph.nodes.find(n => n.address === fn.dependsOn[0])?.origin).toContain(resource.id);
    expect(graph.notes.some(note => note.includes('depends on "absent"'))).toBe(true);
  });
  it("refuses the unbound template instead of accepting fictional digest evidence", () => { expect(ManifestV2.safeParse(template).success).toBe(false); });
});
