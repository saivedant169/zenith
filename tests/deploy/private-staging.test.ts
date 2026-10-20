import { describe, expect, it } from "vitest";
import { stagedComposition, stagedPath, stagingArguments } from "../../scripts/deploy/private-staging.mjs";

const privateRoot = "/stack", stageRoot = "/stack/staged";
const image = `temporalio/server:1.32.0@sha256:${"a".repeat(64)}`;
const document = { services: {
  temporal: { user: "1000:1000", volumes: ["temporal-data:/home/temporal", "/repo/deploy/self-hosted/temporal-disposable.yaml:/etc/zenith-temporal/server.yaml:ro",
    "/stack/installation/temporal-tls/server.key:/run/zenith-temporal/server.key:ro"] },
  api: { user: "1001:1001", volumes: ["/stack/installation/../tls/ca.crt:/run/zenith-ca.crt:ro", "/stack/installation/temporal-tls/client.key:/run/zenith-temporal/client.key:ro"] },
  "api-peer": { user: "1001:1001", volumes: ["/stack/tls/ca.crt:/run/zenith-ca.crt:ro"] },
  worker: { user: "10001:10001", volumes: ["/stack/tls/ca.crt:/run/zenith-ca.crt:ro"] },
  rootService: { volumes: ["/stack/tls/edge.key:/run/edge.key:ro"] },
} };

describe("private bind staging", () => {
  it("binds originals unchanged where Docker maps ownership", () => {
    const result = stagedComposition(document, { privateRoot, stageRoot, platform: "darwin" });
    expect(result.document).toBe(document);
    expect(result.copies).toEqual([]);
  });

  it("stages one 0400 copy per private file and consuming uid on native Linux", () => {
    const { document: staged, copies } = stagedComposition(document, { privateRoot, stageRoot, platform: "linux" });
    const ca1001 = stagedPath(stageRoot, 1001, "/stack/tls/ca.crt");
    expect(staged.services.api.volumes[0]).toBe(`${ca1001}:/run/zenith-ca.crt:ro`);
    expect(staged.services["api-peer"].volumes[0]).toBe(`${ca1001}:/run/zenith-ca.crt:ro`);
    expect(staged.services.worker.volumes[0]).toBe(`${stagedPath(stageRoot, 10001, "/stack/tls/ca.crt")}:/run/zenith-ca.crt:ro`);
    // Named volumes, repository files and root services keep their binds.
    expect(staged.services.temporal.volumes.slice(0, 2)).toEqual(document.services.temporal.volumes.slice(0, 2));
    expect(staged.services.rootService).toEqual(document.services.rootService);
    expect(copies.map(copy => `${copy.uid}:${copy.gid} ${copy.source}`).sort()).toEqual([
      "10001:10001 /stack/tls/ca.crt",
      "1000:1000 /stack/installation/temporal-tls/server.key",
      "1001:1001 /stack/installation/temporal-tls/client.key",
      "1001:1001 /stack/tls/ca.crt",
    ]);
    expect(document.services.api.volumes[0]).toBe("/stack/installation/../tls/ca.crt:/run/zenith-ca.crt:ro");
  });

  it("copies through a networkless root helper with only ownership capabilities", () => {
    const { copies } = stagedComposition(document, { privateRoot, stageRoot, platform: "linux" });
    const args = stagingArguments(copies, { stageRoot, image, labels: { "io.zenith.installation": "x" } });
    expect(args.slice(0, 6)).toEqual(["run", "--rm", "--network", "none", "--user", "0:0"]);
    expect(args.filter((_, index) => args[index - 1] === "--cap-add")).toEqual(["CHOWN", "DAC_OVERRIDE", "FOWNER"]);
    expect(args).toContain("--read-only");
    expect(args.filter(arg => arg.includes(",target=/in/"))).toHaveLength(copies.length);
    expect(args.filter(arg => arg.includes(",target=/in/")).every(arg => arg.endsWith(",readonly"))).toBe(true);
    const script = args.at(-1)!;
    expect(script.split("\n")).toHaveLength(copies.length);
    expect(script).toContain("chown 1000:1000");
    expect(script.match(/chmod 0400/g)).toHaveLength(copies.length);
    expect(() => stagingArguments(copies, { stageRoot, image: "temporalio/server:1.32.0" })).toThrow("private-staging:image-digest");
    expect(() => stagingArguments([], { stageRoot, image })).toThrow("private-staging:empty");
  });
});
