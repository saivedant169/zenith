import { describe, expect, it } from "vitest";
import { z } from "zod";
import { legacyIssueCode } from "@/lib/zod-issue-code";

const code = (schema: z.ZodType, value: unknown) => legacyIssueCode(schema.safeParse(value).error!.issues[0]);
describe("zod 3 issue codes in API error text", () => {
  it("maps zod 4's renamed codes back to the names clients match on", () => {
    expect(code(z.enum(["a", "b"]), "c")).toBe("invalid_enum_value");
    expect(code(z.literal("x"), "y")).toBe("invalid_literal");
    expect(code(z.string().regex(/^a$/), "b")).toBe("invalid_string");
    expect(code(z.discriminatedUnion("k", [z.object({ k: z.literal("a") }), z.object({ k: z.literal("b") })]), { k: "q" })).toBe("invalid_union_discriminator");
    expect(code(z.string(), 1)).toBe("invalid_type");
    expect(code(z.object({}).strict(), { extra: 1 })).toBe("unrecognized_keys");
  });
});
