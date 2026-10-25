import { describe, expect, it } from "vitest";
import { dataRetentionMain } from "../../scripts/data-retention";

describe("data-retention failure line", () => {
  it("names the error type and code but never echoes the connection URL", async () => {
    const errors: string[] = [];
    const code = await dataRetentionMain([], () => undefined, (line) => errors.push(line), { ZENITH_PLATFORM_DB_URL: "postgres://secret-user:secret-pass@127.0.0.1:1/zenith" });
    expect(code).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^Data retention failed \([A-Za-z]{1,40}(:[A-Za-z0-9_]{1,40})?(<[A-Za-z]{1,40}(:[A-Za-z0-9_]{1,40})?){0,2}\)\. /);
    expect(errors[0]).not.toMatch(/secret|127\.0\.0\.1|postgres:/);
  });
});
