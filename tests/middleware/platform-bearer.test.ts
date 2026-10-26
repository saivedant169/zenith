/** Edge gate coverage and a source inventory: new REST methods must be classified. */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { isAgentSignedPath } from "@/lib/runners/paths";
import { PLATFORM_PATHS, isPlatformBearerRequest, platformAccess } from "@/app/api/platform/v1/_lib/bearer-paths";

const gate = vi.hoisted(() => ({ session: vi.fn(), hosted: vi.fn() }));
vi.mock("@/lib/supabase/middleware", () => ({ updateSession: gate.session }));
vi.mock("@/lib/hosted/edge", () => ({ hostedRewrite: gate.hosted, isPlatformStaticPath: () => false }));
import { middleware } from "@/middleware";

const ROOT = "/api/platform/v1";
const TOKEN = `Bearer za_${"a".repeat(43)}`;
const bearerRoutes = [
  ["POST", "/capabilities/propose"], ["POST", "/capabilities/check"],
  ["GET", "/operations"], ["GET", "/operations/op_1"],
  ["GET", "/operations/op_1/events"], ["POST", "/operations/op_1/cancel"],
  ["GET", "/environments/env_1/autonomy"], ["GET", "/workspace/policy"], ["GET", "/capability-catalog"],
  ["GET", "/environments/env_1/teardown-review"], ["POST", "/environments/env_1/teardown-review"],
  ["GET", "/environments/env_1/spend"],
  ["GET", "/connections"], ["GET", "/connections/conn_1"], ["POST", "/connections/conn_1/verify"], ["POST", "/connections/conn_1/revoke"],
  ["GET", "/environments/env_1/state-backend"], ["POST", "/environments/env_1/state-backend/probe"], ["POST", "/environments/env_1/state-backend/restores"],
  ["GET", "/effects"], ["GET", "/effects/fx_1"], ["POST", "/effects/fx_1/readback"],
];
const browserRoutes = [
  ["GET", "/environments/env_1/optimizer"], ["POST", "/environments/env_1/optimizer"],
  ["POST", "/operations/op_1/approve"], ["POST", "/operations/op_1/reject"],
  ["PUT", "/environments/env_1/autonomy"], ["PUT", "/workspace/policy"],
  ["GET", "/github/callback"], ["POST", "/github/callback"],
  ["GET", "/runners"], ["GET", "/machines"], ["POST", "/runners/tokens"],
  ["POST", "/runners/run_1/revoke"], ["POST", "/machines/mac_1/revoke"],
  ["GET", "/runners/run_1/update"], ["POST", "/runners/run_1/update"],
  ["GET", "/machines/mac_1/update"], ["POST", "/machines/mac_1/update"],
  ["POST", "/effects/fx_1/resolve"],
  ["POST", "/environments/env_1/spend"],
  ["POST", "/connections"], ["POST", "/connections/conn_1/rotate"], ["POST", "/connections/conn_1/rotation/promote"], ["POST", "/connections/conn_1/rotation/abort"],
  ["POST", "/environments/env_1/state-backend/restores/approve"], ["POST", "/environments/env_1/state-backend/restores/reject"], ["POST", "/environments/env_1/state-backend/restores/execute"],
];

beforeEach(() => {
  vi.clearAllMocks();
  gate.hosted.mockReturnValue(undefined);
  gate.session.mockImplementation(async () => NextResponse.json({ error: "cookie gate" }, { status: 401 }));
});

describe("platform bearer cookie-gate bypass", () => {
  it("bypasses only exact launcher check and catalog methods, preserving browser/MFA consent routes", async () => {
    for (const [method, suffix] of [["POST", "launch/check"], ["GET", "catalog"]]) {
      const response = await middleware(new NextRequest(`https://zenith.test/api/integrations/plugins/${suffix}`, { method }));
      expect(response.headers.get("x-middleware-next")).toBe("1");
      expect(gate.session).not.toHaveBeenCalled();
    }
    for (const [method, suffix] of [["GET", "launch/check"], ["POST", "catalog"], ["POST", "launch/check/"], ["POST", "launch/tokens"], ["POST", "review"]]) {
      vi.clearAllMocks();
      expect((await middleware(new NextRequest(`https://zenith.test/api/integrations/plugins/${suffix}`, { method, headers: { authorization: TOKEN } }))).status).toBe(401);
      expect(gate.session).toHaveBeenCalledOnce();
    }
  });
  it("admits only the exact signed webhook POST transport, keeping browser mutations gated", async () => {
    const path = `${ROOT}/github/webhook`;
    expect(platformAccess(path, "POST")).toBe("webhook-signed");
    expect(isPlatformBearerRequest(path, "POST", TOKEN)).toBe(false);
    expect((await middleware(new NextRequest(`https://zenith.test${path}`, { method: "POST" }))).headers.get("x-middleware-next")).toBe("1");
    expect(gate.session).not.toHaveBeenCalled();
    for (const [method, suffix] of [["GET", "/github/webhook"], ["PUT", "/github/webhook"], ["POST", "/github/webhook/"], ["POST", "/github/webhook/more"], ["POST", "/github/callback"]]) {
      vi.clearAllMocks();
      expect((await middleware(new NextRequest(`https://zenith.test${ROOT}${suffix}`, { method, headers: { authorization: TOKEN } }))).status).toBe(401);
      expect(gate.session).toHaveBeenCalledOnce();
    }
  });
  it.each(bearerRoutes)("lets %s %s reach credential authentication", async (method, suffix) => {
    const response = await middleware(new NextRequest(`https://zenith.test${ROOT}${suffix}`, { method, headers: { authorization: TOKEN } }));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(gate.session).not.toHaveBeenCalled();
  });

  it.each(bearerRoutes)("keeps %s %s on the cookie gate without a bearer", async (method, suffix) => {
    const response = await middleware(new NextRequest(`https://zenith.test${ROOT}${suffix}`, { method }));
    expect(response.status).toBe(401);
    expect(gate.session).toHaveBeenCalledOnce();
  });

  it.each(browserRoutes)("keeps %s %s on the cookie gate even with a bearer", async (method, suffix) => {
    expect((await middleware(new NextRequest(`https://zenith.test${ROOT}${suffix}`, { method, headers: { authorization: TOKEN } }))).status).toBe(401);
    expect(gate.session).toHaveBeenCalledOnce();
  });

  it.each(["runners", "machines"])("keeps %s update controls on human browser authority", (collection) => {
    const pathname = `${ROOT}/${collection}/x/update`;
    expect(platformAccess(pathname, "GET")).toBe("browser-only");
    expect(platformAccess(pathname, "POST")).toBe("admin");
    expect(isPlatformBearerRequest(pathname, "GET", TOKEN)).toBe(false);
    expect(isPlatformBearerRequest(pathname, "POST", TOKEN)).toBe(false);
    expect(isAgentSignedPath(pathname)).toBe(false);
  });

  it.each(["GET", "POST"])("classifies GitHub installation and binding %s as browser-only", (method) => {
    expect(platformAccess(`${ROOT}/github/callback`, method)).toBe("browser-only");
    expect(isPlatformBearerRequest(`${ROOT}/github/callback`, method, TOKEN)).toBe(false);
  });

  it.each(["", "Basic abcdefgh", "Bearer", "Bearer ", "Bearer abc def", "Bearer\tabc", "BearerX abc"])("does not bypass with header %j", (authorization) => {
    expect(isPlatformBearerRequest(`${ROOT}/operations`, "GET", authorization)).toBe(false);
  });

  it("leaves token validity to the authority, including forged tokens", () => {
    expect(isPlatformBearerRequest(`${ROOT}/operations`, "GET", "Bearer forged")).toBe(true);
    expect(isPlatformBearerRequest(`${ROOT}/operations`, "GET", "bearer forged")).toBe(true);
  });

  it.each(["HEAD", "OPTIONS", "POST", "PATCH", "DELETE", "get"])("does not implicitly admit method %s on the operation list", (method) => {
    expect(isPlatformBearerRequest(`${ROOT}/operations`, method, TOKEN)).toBe(false);
  });

  it.each([
    "/operations/", "/operations/op_1/", "/operations/op_1/events/more",
    "/operations/../events", "/operations/./events", "/operations/op%2f1/events",
    "/operations/op.1/events", "/operations/op:1/events", "/operations//events",
    `/operations/${"x".repeat(101)}`, "/Operations", "/workspace/policy/extra",
    "/capabilities/check/extra", "/capabilities/unknown", "/unknown",
  ])("anchors the allowlist against path %s", (suffix) => {
    for (const method of ["GET", "POST", "PUT"]) expect(isPlatformBearerRequest(`${ROOT}${suffix}`, method, TOKEN)).toBe(false);
  });

  it("keeps hosted routing first", async () => {
    gate.hosted.mockReturnValue(NextResponse.redirect("https://app.example.test"));
    expect((await middleware(new NextRequest(`https://zenith.test${ROOT}/operations`, { headers: { authorization: TOKEN } }))).status).toBe(307);
    expect(gate.session).not.toHaveBeenCalled();
  });

  it.each(["runners", "machines"])("preserves %s signed routes without cookies or bearers", async (collection) => {
    for (const suffix of ["register", "x/poll", "x/heartbeat", "x/jobs/y/result", "x/jobs/y/logs"]) {
      const response = await middleware(new NextRequest(`https://zenith.test${ROOT}/${collection}/${suffix}`, { method: "POST" }));
      expect(response.headers.get("x-middleware-next")).toBe("1");
    }
    expect(gate.session).not.toHaveBeenCalled();
  });
});

describe("platform route inventory", () => {
  function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(dir, entry.name);
      return entry.isDirectory() ? files(file) : entry.name === "route.ts" ? [file] : [];
    });
  }

  it("classifies every exported REST method exactly once, including mixed read/write routes", () => {
    const root = path.resolve("src/app/api/platform/v1");
    const seen = new Set<string>();
    for (const file of files(root)) {
      const pathname = ROOT + "/" + path.relative(root, path.dirname(file)).replaceAll("\\", "/").replace(/\[(?:id|jti)\]/g, "x");
      const normalized = pathname.replace(/\/$/, "");
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      const names: string[] = [];
      for (const statement of source.statements) {
        if (ts.isVariableStatement(statement) && statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
          for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
        } else if (ts.isFunctionDeclaration(statement) && statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) && statement.name) names.push(statement.name.text);
        else if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) names.push(...statement.exportClause.elements.map((e) => e.name.text));
      }
      const methods = names.filter((name) => ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"].includes(name));
      expect(methods.length, file).toBeGreaterThan(0);
      for (const method of methods) {
        const matches = PLATFORM_PATHS.filter((entry) => entry.path.test(normalized) && entry.methods[method]);
        expect(matches, `${method} ${normalized}`).toHaveLength(1);
        const access = platformAccess(normalized, method);
        seen.add(`${method} ${normalized}`);
        expect(isAgentSignedPath(normalized), normalized).toBe(access === "agent-signed");
      }
    }
    expect(seen.size).toBe(118);
    for (const entry of PLATFORM_PATHS) {
      expect(entry.path.source.startsWith("^")).toBe(true);
      expect(entry.path.source.endsWith("$")).toBe(true);
      expect(entry.path.global || entry.path.sticky).toBe(false);
    }
  });
});
