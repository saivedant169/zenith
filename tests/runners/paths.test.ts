/**
 * Which paths the session middleware must let through without a cookie (they authenticate by agent
 * signature). The set is exact: a path that is not an agent call must NOT be in it, or an unauthenticated
 * caller would bypass the session gate on an admin route.
 */
import { describe, expect, it } from "vitest";
import { isAgentSignedPath } from "@/lib/runners/paths";

describe("isAgentSignedPath", () => {
  const P = "/api/platform/v1";
  it("accepts every agent-signed endpoint, for runners and machines", () => {
    for (const c of ["runners", "machines"]) {
      for (const suffix of ["register", "run_abc-123/poll", "run_abc-123/heartbeat", "run_1/jobs/job_2/result", "run_1/jobs/job_2/logs", "run_1/jobs/job_2/grant", "mac_1.x:y/poll"]) expect(isAgentSignedPath(`${P}/${c}/${suffix}`), `${c}/${suffix}`).toBe(true);
    }
  });

  it("rejects the admin (session) routes and everything else", () => {
    const admin = [
      `${P}/runners/tokens`,
      `${P}/runners`,
      `${P}/machines`,
      `${P}/runners/run_1/revoke`,
      `${P}/machines/mac_1/revoke`,
      `${P}/runners/run_1`,
      `${P}/runners/run_1/jobs`,
      `${P}/runners/run_1/jobs/job_2`,
      `${P}/runners/run_1/jobs/job_2/cancel`,
      `${P}/runners/run_1/poll/extra`,
      `${P}/runners/register/extra`,
      `${P}/runners//poll`,
      `${P}/runners/run 1/poll`,
      `${P}/runners/run_1/poll/`,
      `${P}/runners/../tokens`,
      `${P}/runners/../poll`,
      `${P}/runners/./heartbeat`,
      `${P}/other/run_1/poll`,
      `/api/agent/v2/mcp`,
      `/api/workspace/invites`,
      `${P}/runners/${"x".repeat(129)}/poll`,
    ];
    for (const p of admin) expect(isAgentSignedPath(p), p).toBe(false);
  });
});

describe("isAgentSignedPath: one-character ids are ids", () => {
  it("accepts a short id but never a dot segment", () => {
    expect(isAgentSignedPath("/api/platform/v1/runners/x/poll")).toBe(true);
    expect(isAgentSignedPath("/api/platform/v1/runners/ab/jobs/c/result")).toBe(true);
    expect(isAgentSignedPath("/api/platform/v1/runners/../poll")).toBe(false);
    expect(isAgentSignedPath("/api/platform/v1/runners/run_1/jobs/../result")).toBe(false);
  });
});
