/** Real package compatibility checks. No SMTP server, HTTP calls or test shims. */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));

describe("approved dependency remediation", () => {
  it("preserves the supported runtime and pins both major migrations", () => {
    expect(pkg.engines.node).toBe(">=22.22.2 <23");
    expect(lock.packages[""].engines.node).toBe(pkg.engines.node);
    expect(pkg.dependencies.nodemailer).toBe("10.0.10");
    expect(pkg.devDependencies.vitest).toBe("4.1.12");
    expect(require("nodemailer/package.json").version).toBe("10.0.10");
    expect(require("vitest/package.json").version).toBe("4.1.12");
    expect(require("@vitest/mocker/package.json").version).toBe("4.1.12");
  });

  it("resolves the root HTTP client and the E2B alias to the fixed branch without replacing Undici 7", () => {
    expect(require("undici/package.json").version).toBe("8.10.2");
    expect(require("undici8/package.json").version).toBe("8.10.2");
    expect(typeof require("undici").fetch).toBe("function");
    expect(typeof require("undici8").fetch).toBe("function");
    const e2bRequire = createRequire(require.resolve("e2b/package.json"));
    expect(e2bRequire("undici/package.json").version).toBe("7.29.1");
    expect(pkg.overrides.e2b.undici8).toBe("npm:undici@8.10.2");
  });

  it.each([
    ["brace-expansion", "1.1.21"],
    ["glob/node_modules/brace-expansion", "5.0.12"],
    ["@typescript-eslint/typescript-estree/node_modules/brace-expansion", "5.0.12"],
  ])("retains normal expansion behavior in %s", (modulePath, version) => {
    const directory = path.join(root, "node_modules", modulePath);
    expect(JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")).version).toBe(version);
    const loaded = require(directory);
    const expand = typeof loaded === "function" ? loaded : loaded.expand ?? loaded.default;
    expect(expand("src/{one,two}/file{1,2}.ts")).toEqual([
      "src/one/file1.ts", "src/one/file2.ts", "src/two/file1.ts", "src/two/file2.ts",
    ]);
  });

  it("loads the overridden PostCSS through Next and retains CSS/source-map processing", async () => {
    const nextRequire = createRequire(require.resolve("next/package.json"));
    expect(nextRequire("postcss/package.json").version).toBe("8.5.23");
    const postcss = nextRequire("postcss") as typeof import("postcss").default;
    const css = ".card { color: red; --spacing: 8px; }\n@media (width > 600px) { .card { display: grid; } }";
    const result = await postcss([]).process(css, {
      from: path.join(root, "compat-input.css"),
      to: path.join(root, "compat-output.css"),
      map: { inline: false, annotation: false, sourcesContent: true },
    });
    expect(result.css).toBe(css);
    expect(result.root.nodes).toHaveLength(2);
    expect(result.warnings()).toEqual([]);
    expect(result.map?.toJSON()).toMatchObject({ version: 3, sourcesContent: [css] });
  });

  it("keeps Nodemailer's ESM/CommonJS transport APIs and SMTP URL parsing compatible", async () => {
    const imported = await import("nodemailer");
    const api = typeof imported.createTransport === "function" ? imported : imported.default;
    expect(typeof api.createTransport).toBe("function");
    expect(typeof require("nodemailer").createTransport).toBe("function");
    const transport = api.createTransport("smtp://test%3Auser:dummy-password@example.invalid:2525/?secure=false");
    try {
      expect(transport).toHaveProperty("options.host", "example.invalid");
      expect(transport).toHaveProperty("options.port", 2525);
      expect(transport).toHaveProperty("options.auth.user", "test:user");
      expect(typeof transport.sendMail).toBe("function");
      expect(typeof transport.close).toBe("function");
    } finally { transport.close(); }
  });

  it("produces a real buffered email with the string recipient shape used by both callers", async () => {
    const imported = await import("nodemailer");
    const api = typeof imported.createTransport === "function" ? imported : imported.default;
    const transport = api.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
    try {
      const sent = await transport.sendMail({
        from: "Zenith <sender@example.test>", to: "Operator <recipient@example.test>",
        subject: "Dependency compatibility", text: "dependency-remediation-body", disableFileAccess: true, disableUrlAccess: true,
      });
      expect(sent.envelope).toEqual({ from: "sender@example.test", to: ["recipient@example.test"] });
      expect(sent.messageId).toMatch(/^<.+>$/);
      if (!Buffer.isBuffer(sent.message)) throw new Error("Expected a buffered MIME message");
      const mime = sent.message.toString("utf8");
      expect(mime).toContain("Subject: Dependency compatibility");
      expect(mime).toContain("dependency-remediation-body");
    } finally { transport.close(); }
  });
});
