/** Pin the externally visible catalog, independent of handlers. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fromJsonSchema, type JsonSchemaType } from "@modelcontextprotocol/server";
import golden from "./golden/catalog.json";
import { CAPABILITIES, type CapabilityName } from "@/lib/capabilities/catalog";
import { digest } from "@/lib/controlplane/digest";
import { TOOL_CATALOG, TOOL_SCHEMAS, catalogDigest, catalogFor } from "@/lib/agent-access/v3/catalog";
import { TOOL_NAMES } from "@/lib/agent-access/v3/contract";
import { argsFor } from "./support";

describe("MCP v3 catalog", () => {
  it("has exactly the nineteen semantic tools", () => {
    expect(TOOL_CATALOG.map((t) => t.name)).toEqual(TOOL_NAMES);
    expect(TOOL_CATALOG).toHaveLength(19);
  });
  it.each(TOOL_CATALOG)("$name publishes its strict input contract, digest and hints", async (tool) => {
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.schemaVersion).toBeGreaterThan(0);
    expect(tool.schemaDigest).toBe(`sha256:${digest(tool.inputSchema)}`);
    expect(tool.inputSchema).not.toHaveProperty("$schema");
    expect(Object.values(tool.annotations).every((v) => typeof v === "boolean")).toBe(true);
    expect(TOOL_SCHEMAS[tool.name].safeParse({ ...argsFor(tool.name), approved: true }).success).toBe(false);
    if (tool.capability) expect(CAPABILITIES[tool.capability as CapabilityName].integrationScope).toBe(tool.requiredScope);
    if (tool.access === "execute") expect(tool.requiredScope).toBe("write");
    const standard = fromJsonSchema(tool.inputSchema as JsonSchemaType)["~standard"];
    expect(await standard.validate(argsFor(tool.name))).toHaveProperty("value");
    expect(await standard.validate({ ...argsFor(tool.name), approved: true })).toHaveProperty("issues");
  });
  it("pins schema versions and digests in the golden contract", () => {
    expect({ catalogDigest: catalogDigest(), tools: TOOL_CATALOG.map(({ name, schemaVersion, schemaDigest }) => ({ name, schemaVersion, schemaDigest })) }).toEqual(golden);
  });
  it("keeps the generated documentation table identical to the catalog", () => {
    const table = ["| Tool | Capability | Access | Scope | R/D/I/O |", "|---|---|---|---|---|",
      ...TOOL_CATALOG.map((t) => `| \`${t.name}\` | ${t.capability ? `\`${t.capability}\`` : "operation capability"} | ${t.access} | \`${t.requiredScope}\` | ${[t.annotations.readOnlyHint, t.annotations.destructiveHint, t.annotations.idempotentHint, t.annotations.openWorldHint].map((b) => b ? "T" : "F").join("/")} |`)];
    const docs = readFileSync(new URL("../../docs/platform/MCP.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    expect(docs.split("<!-- catalog:start -->\n")[1].split("\n<!-- catalog:end -->")[0]).toBe(table.join("\n"));
  });
  it("filters each scope independently", () => {
    expect(catalogFor(["read"]).every((t) => t.access === "read")).toBe(true);
    expect(catalogFor(["read"])).not.toContainEqual(expect.objectContaining({ name: "zenith_query_logs" }));
    expect(catalogFor(["read", "logs"])).toContainEqual(expect.objectContaining({ name: "zenith_query_logs" }));
    expect(catalogFor(["read", "plan"])).toContainEqual(expect.objectContaining({ name: "zenith_plan_change" }));
    expect(catalogFor(["read"])).not.toContainEqual(expect.objectContaining({ name: "zenith_plan_runner_connection" }));
    expect(catalogFor(["read", "plan"])).toContainEqual(expect.objectContaining({ name: "zenith_plan_runner_connection", access: "read", capability: "connection.plan" }));
    expect(catalogFor(["read"])).not.toContainEqual(expect.objectContaining({ name: "zenith_recommend_placement" }));
    expect(catalogFor(["read", "plan"])).toContainEqual(expect.objectContaining({ name: "zenith_recommend_placement", access: "read", capability: "placement.solve" }));
    expect(catalogFor(["read", "plan"]).some((t) => t.requiredScope === "write")).toBe(false);
    expect(catalogFor(["read", "write"]).filter((t) => t.requiredScope === "write")).toHaveLength(4);
    expect(catalogFor(["unknown"])).toEqual([]);
  });
});
