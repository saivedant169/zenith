import { describe, expect, it } from "vitest";
import { linuxPrivateBinds } from "../../scripts/deploy/installation.mjs";
import { stagedPath } from "../../scripts/deploy/private-staging.mjs";

const dir = "/opt/zenith-installation-test";
const disposable = { mode: "disposable", installationId: "a".repeat(24) } as never;
const target = (mount: unknown) => String(mount).split(":")[1];

describe("installer private binds on native Linux", () => {
  it("adds nothing for production mode or Docker Desktop hosts", () => {
    expect(linuxPrivateBinds({ mode: "production" } as never, dir, "linux")).toEqual({ document: { services: {} }, copies: [] });
    expect(linuxPrivateBinds(disposable, dir, "darwin")).toEqual({ document: { services: {} }, copies: [] });
  });

  it("remaps each disposable private bind target to a copy owned by its consuming uid", () => {
    const { document, copies } = linuxPrivateBinds(disposable, dir, "linux");
    expect(Object.keys(document.services).sort()).toEqual(["api", "execution-worker", "temporal", "temporal-setup"]);
    const tls = (name: string) => `${dir}/temporal-tls/${name}`;
    expect(document.services.temporal.volumes).toEqual(["ca.crt", "server.crt", "server.key"]
      .map(name => `${stagedPath(`${dir}/staged`, 1000, tls(name))}:/run/zenith-temporal/${name}:ro`));
    expect(document.services.api.volumes.map(target)).toEqual(["/run/zenith-temporal/ca.crt", "/run/zenith-temporal/client.crt", "/run/zenith-temporal/client.key"]);
    expect(document.services.api.volumes[2]).toContain(stagedPath(`${dir}/staged`, 1001, tls("client.key")));
    expect(document.services["execution-worker"].volumes[2]).toContain(stagedPath(`${dir}/staged`, 10001, tls("client.key")));
    // Repository files and named volumes are never overridden.
    expect(JSON.stringify(document)).not.toContain("temporal-disposable.yaml");
    expect(JSON.stringify(document)).not.toContain("temporal-data");
    expect(copies.every(copy => copy.source.startsWith(`${dir}/temporal-tls/`))).toBe(true);
    expect(new Set(copies.map(copy => copy.uid))).toEqual(new Set(["1000", "1001", "10001"]));
  });
});
