/** Offline: the owner-approved Calico pin refuses any manifest other than the reviewed upstream bytes. */
import { describe, expect, it } from "vitest";
import { CALICO_IMAGES, pinnedCalico } from "../../../scripts/release/drivers/drv1-isolation";

describe("DRV-1 isolation pins", () => {
  it("refuses a manifest whose bytes differ from the reviewed Calico v3.33.0 release", () => {
    expect(() => pinnedCalico("kind: DaemonSet\n        image: quay.io/calico/node:v3.33.0\n")).toThrow("drv1-isolation:calico-manifest-digest");
  });
  it("pins every reviewed Calico image by index digest", () => {
    expect(Object.keys(CALICO_IMAGES).sort()).toEqual(["quay.io/calico/calico:v3.33.0", "quay.io/calico/node:v3.33.0", "quay.io/calico/third-party-cni-plugins:v3.33.0"]);
    expect(Object.values(CALICO_IMAGES).every(digest => /^sha256:[a-f0-9]{64}$/.test(digest))).toBe(true);
  });
});
