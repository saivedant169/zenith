import { describe, expect, it } from "vitest";
import { workspaceSlug } from "@/lib/domain/workspace-slug";

describe("workspaceSlug", () => {
  it("keeps the plain slug in demo mode and gives shared tenants distinct slugs for the same name", () => {
    expect(workspaceSlug("Acme Inc.", "w1", false)).toBe("acme-inc");
    const a = workspaceSlug("Acme Inc.", "mvgbycbuyz31it", true), b = workspaceSlug("Acme Inc.", "mvgbydf2l6rttb", true);
    expect([a, b]).toEqual(["acme-inc-yz31it", "acme-inc-l6rttb"]);
    expect(workspaceSlug("!!!", "abc", true)).toBe("workspace-abc");
  });
});
