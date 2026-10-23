/**
 * PROD-UX-01: axe (WCAG 2.0/2.1 A and AA rules) over every state of the legacy-engine cancellation control. The J2
 * browser journey cannot reach this control: it renders only for legacy (non-workflow) deployments, which J2 never
 * creates. jsdom has no layout, so axe's color-contrast rule cannot run here (axe reports it "incomplete", never as a
 * pass); the control uses the shared Button component whose contrast the browser audits cover on other pages.
 */
import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LegacyCancel } from "@/app/(product)/platform/deployments/[id]/legacy-cancel";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/client/api", async (original) => ({ ...await original<typeof import("@/lib/client/api")>(), executeAction: mocks.execute }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
let host: HTMLElement, root: Root;
beforeEach(() => {
  vi.resetAllMocks();
  // A landmark around the fragment, as the deployment page provides.
  host = document.createElement("main"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const button = (name: string) => [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === name)!;
const click = async (element: HTMLElement) => { await act(async () => element.click()); };
async function audit(): Promise<{ violations: string[]; incomplete: string[] }> {
  const result = await axe.run(host, { runOnly: { type: "tag", values: TAGS } });
  return { violations: result.violations.map((v) => v.id), incomplete: result.incomplete.map((v) => v.id) };
}

describe("legacy cancellation control under axe", () => {
  it("has no violations when offered, while confirming, after success and after an unconfirmed outcome", async () => {
    await act(async () => root.render(<LegacyCancel deploymentId="dep" canCancel />));
    expect((await audit()).violations).toEqual([]);
    await click(button("Cancel deployment"));
    expect(button("Confirm cancellation")).toBeDefined();
    expect((await audit()).violations).toEqual([]);
    mocks.execute.mockResolvedValueOnce({ ok: false });
    await click(button("Confirm cancellation"));
    expect(host.textContent).toContain("could not be confirmed");
    expect((await audit()).violations).toEqual([]);
    // An unconfirmed outcome keeps the confirmation open for a deliberate retry.
    mocks.execute.mockResolvedValueOnce({ ok: true });
    await click(button("Confirm cancellation"));
    expect(host.textContent).toContain("Cancellation recorded");
    expect((await audit()).violations).toEqual([]);
  });

  it("has no violations when a viewer sees the disabled control and its explanation", async () => {
    await act(async () => root.render(<LegacyCancel deploymentId="dep" canCancel={false} />));
    const { violations, incomplete } = await audit();
    expect(violations).toEqual([]);
    // Contrast needs layout; it is reported as not evaluated, never silently passed.
    expect(incomplete.every((id) => id === "color-contrast")).toBe(true);
  });
});
