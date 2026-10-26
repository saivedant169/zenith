/**
 * Static audit: every repository function that touches a tenant table scopes it
 * by `workspace_id` IN SQL (WS-SEC; architecture invariant 2, ground rule 6).
 *
 * `tests/controlplane/tenancy.test.ts` is the dynamic sweep: it runs every
 * function as workspace B against workspace A's rows. This is its independent
 * cross-check, from the other side: it reads the SOURCE of every repository
 * (`src/lib/controlplane/db/repos/*.ts`) and requires that any exported function
 * whose body mentions a tenant table also mentions `workspace_id`. A function
 * that forgets the predicate cannot hide behind a sweep that does not know it
 * exists, and a function that is deliberately unscoped must be named here with
 * the reason — so the set of cross-tenant-capable queries is a reviewed list,
 * not an accident.
 *
 * Limits (honest): this is a text check. It proves the predicate is PRESENT in
 * the function, not that it is correct (that is the sweep's job) and it cannot
 * generally see SQL built in another module. The native plan claim/dispatch
 * composer has a separate bounded AST provenance proof below; it establishes
 * literal SQL composition, not semantic authorization. Tenant tables are
 * discovered from migrations: every table that has a `workspace_id` column.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.join(process.cwd(), "src", "lib", "controlplane", "db");
const REPOS = path.join(ROOT, "repos");
// Proofs never mutate ASTs. Cache only exact source bytes, including hostile
// mutations, so repeated provenance checks avoid reparsing the large repository.
// Bound the cache to keep the shared builder's memory use predictable.
const sourceCache = new Map<string, ts.SourceFile>();
function parseSource(file: string, source: string): ts.SourceFile {
  const key = `${file}\0${source}`;
  let parsed = sourceCache.get(key);
  if (!parsed) parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  sourceCache.delete(key);
  sourceCache.set(key, parsed);
  if (sourceCache.size > 128) sourceCache.delete(sourceCache.keys().next().value!);
  return parsed;
}

// COST joins add direct reads outside repositories; each new query is reviewed here too.
const COST_SQL_INVENTORY = {
  "src/lib/cost/optimizer-settings-service.ts": 1,
  "src/lib/cost/optimizer/optimizer-ownership.ts": 2,
  "src/lib/cost/usage-exporter.ts": 1,
  "src/lib/platform/optimizer.ts": 1,
} as const;

describe("cost direct SQL scoping inventory", () => {
  it("binds the actual workspace predicate for every inventoried tenant query", () => {
    for (const [file, expected] of Object.entries(COST_SQL_INVENTORY)) {
      const source = ts.createSourceFile(file, readFileSync(path.join(process.cwd(), file), "utf8"), ts.ScriptTarget.Latest, true);
      let queries = 0;
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "query") {
          const [text, params] = node.arguments;
          expect(ts.isStringLiteral(text) || ts.isNoSubstitutionTemplateLiteral(text), `${file}: SQL must be literal`).toBe(true);
          if (ts.isStringLiteral(text) || ts.isNoSubstitutionTemplateLiteral(text)) {
            queries++;
            if (file === "src/lib/cost/optimizer-settings-service.ts") {
              expect(text.text).toBe("select pg_advisory_xact_lock(hashtext($1), hashtext($2))");
              expect(ts.isArrayLiteralExpression(params)).toBe(true);
              if (ts.isArrayLiteralExpression(params)) {
                expect(params.elements[0].getText(source)).toBe("input.workspaceId");
                expect(params.elements[1].getText(source)).toBe("`optimizer-settings:${input.environmentId}`");
              }
              return;
            }
            expect(text.text, file).toMatch(/\bwhere\s+workspace_id\s*=\s*\$1\b/i);
            expect(ts.isArrayLiteralExpression(params), `${file}: explicit bindings`).toBe(true);
            if (ts.isArrayLiteralExpression(params)) expect(params.elements[0].getText(source), file).toMatch(/^(scope|report|environment)\.workspaceId$/);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      expect(queries, `${file}: query inventory changed; review its scope`).toBe(expected);
    }
  });
});

/** Tables that carry a `workspace_id` column, read from the migrations. */
function tenantTables(): string[] {
  const tables = new Set<string>();
  for (const file of readdirSync(path.join(ROOT, "migrations")).filter((f) => /^\d{4}_.*\.ts$/.test(f))) {
    const text = readFileSync(path.join(ROOT, "migrations", file), "utf8");
    for (const m of text.matchAll(/create table(?: if not exists)? platform\.(\w+)\s*\(([\s\S]*?)\n\);/gi)) {
      if (/\bworkspace_id\b/i.test(m[2])) tables.add(m[1]);
    }
  }
  return [...tables].sort();
}

interface Fn {
  file: string;
  name: string;
  body: string;
  source: string;
}

function functionsOf(file: string): Fn[] {
  const text = readFileSync(path.join(REPOS, file), "utf8");
  const starts = [...text.matchAll(/^export (?:async )?function (\w+)/gm)];
  return starts.map((m, i) => ({ file, name: m[1], body: text.slice(m.index!, i + 1 < starts.length ? starts[i + 1].index! : text.length), source: text }));
}

/** The start repository composes two literal authority clauses and chooses only $12/$13 indexes. */
function isFixedStartAuthorityInterpolation(fn: Fn, expression: string, sqlPrefix: string): boolean {
  if (fn.file !== "workflow-start-intents.ts") return false;
  const index = /^(\w+)( \+ 1)?$/.exec(expression);
  if (sqlPrefix.endsWith("$") && index
    && fn.body.includes(`const ${index[1]} = source ? 13 : 12;`)) return true;
  if (!/^\w+$/.test(expression)
    || !fn.body.includes('const ' + expression + ' = `${LIVE_AUTHORITY}${source ? ` and ${MCP_DEPLOY_AUTHORITY}` : ""}`;')) return false;
  // Verify the actual local/imported fragment definitions, not just their names.
  const local = /(?:^|\n)const LIVE_AUTHORITY = `([^`]*)`;/.exec(fn.source);
  const imported = /(?:^|\n)export const MCP_DEPLOY_AUTHORITY = `([^`]*)`;/.exec(
    readFileSync(path.join(REPOS, "workflow-start-deploy-authority.ts"), "utf8"));
  return !!local && !!imported && !local[1].includes("${") && !imported[1].includes("${")
    && /import \{[^}]*\bMCP_DEPLOY_AUTHORITY\b[^}]*\} from "\.\/workflow-start-deploy-authority";/.test(fn.source);
}

/** A closed private literal plus exact genuine-origin calls. Extra references,
 * aliases, assignments or dynamic evaluation cannot inherit a declaration hash. */
function fixedStandaloneBindings(repo: ts.SourceFile): boolean {
  const walk = (node: ts.Node, test: (node: ts.Node) => boolean): boolean => test(node)
    || (ts.forEachChild(node, child => walk(child, test)) ?? false);
  const declarations: ts.VariableDeclaration[] = [], references: ts.Identifier[] = [];
  if (walk(repo, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "LIVE_STANDALONE_SETTLEMENTS") declarations.push(node);
    if (ts.isIdentifier(node) && node.text === "LIVE_STANDALONE_SETTLEMENTS") references.push(node);
    return ts.isIdentifier(node) && ["eval", "Function"].includes(node.text);
  }) || declarations.length !== 1 || references.length !== 5) return false;
  const clause = declarations[0];
  if (!clause.initializer || !ts.isNoSubstitutionTemplateLiteral(clause.initializer)
    || !ts.isVariableDeclarationList(clause.parent) || !(clause.parent.flags & ts.NodeFlags.Const)
    || clause.parent.declarations.length !== 1 || !ts.isVariableStatement(clause.parent.parent)
    || clause.parent.parent.parent !== repo || clause.parent.parent.modifiers?.some(node => node.kind === ts.SyntaxKind.ExportKeyword)
    || createHash("sha256").update(clause.initializer.getText(repo)).digest("hex") !== "eefac8a0c7f5b30257c5b0de7f8f52237e02cc20b4a4490002104ad4ba67a6c6") return false;
  const owners = new Set<string>();
  for (const reference of references) {
    if (reference === clause.name) continue;
    if (!ts.isTemplateSpan(reference.parent) || reference.parent.expression !== reference) return false;
    let owner: ts.Node = reference;
    while (!ts.isFunctionDeclaration(owner) && owner.parent) owner = owner.parent;
    if (!ts.isFunctionDeclaration(owner) || !owner.name || owners.has(owner.name.text)
      || !["dispatch", "retainCleanupWriterHold", "reserveCleanupOwnerGrant", "insertCleanupOwnerGrant"].includes(owner.name.text)) return false;
    owners.add(owner.name.text);
  }
  const calls: Record<string, string[]> = {
    readNativeCleanupOrigin: ['dispatch:readNativeCleanupOrigin(cleanupOrigin,sql,"dispatch")',
      'retainCleanupWriterHold:readNativeCleanupOrigin(origin,sql,"hold")',
      'reserveCleanupOwnerGrant:readNativeCleanupOrigin(origin,sql,"grant")', 'insertCleanupOwnerGrant:readNativeCleanupOrigin(origin,sql,"grant")'],
    assertNativeCleanupOriginCurrent: ['dispatch:assertNativeCleanupOriginCurrent(cleanupOrigin,sql)',
      'retainCleanupWriterHold:assertNativeCleanupOriginCurrent(origin,sql)',
      'reserveCleanupOwnerGrant:assertNativeCleanupOriginCurrent(origin,sql)', 'reserveCleanupOwnerGrant:assertNativeCleanupOriginCurrent(origin,sql)',
      'insertCleanupOwnerGrant:assertNativeCleanupOriginCurrent(origin,sql)', 'insertCleanupOwnerGrant:assertNativeCleanupOriginCurrent(origin,sql)'],
    readNativeStandaloneOrigin: ['dispatch:readNativeStandaloneOrigin(standaloneOrigin,sql,"binding")', 'finishStandalone:readNativeStandaloneOrigin(origin,sql,"completion")'],
    assertNativeStandaloneOriginCurrent: ['dispatch:assertNativeStandaloneOriginCurrent(standaloneOrigin,sql)',
      'dispatch:assertNativeStandaloneOriginCurrent(standaloneOrigin,sql)', 'finishStandalone:assertNativeStandaloneOriginCurrent(origin,sql)'],
  };
  for (const [name, expected] of Object.entries(calls)) {
    const found: ts.Identifier[] = [];
    walk(repo, node => { if (ts.isIdentifier(node) && node.text === name) found.push(node); return false; });
    const imported = found.filter(node => ts.isImportSpecifier(node.parent));
    if (imported.length !== 1 || found.length !== expected.length + 1) return false;
    const specifier = imported[0].parent;
    if (!ts.isImportSpecifier(specifier) || specifier.name !== imported[0] || specifier.isTypeOnly || specifier.propertyName) return false;
    const declaration = specifier.parent.parent.parent;
    if (!ts.isImportDeclaration(declaration) || declaration.importClause?.isTypeOnly
      || !ts.isStringLiteral(declaration.moduleSpecifier) || declaration.moduleSpecifier.text !== "@/lib/platform/plan-artifacts") return false;
    const actual: string[] = [];
    for (const reference of found) {
      if (reference === imported[0]) continue;
      if (!ts.isCallExpression(reference.parent) || reference.parent.expression !== reference) return false;
      let owner: ts.Node = reference.parent;
      while (!ts.isFunctionDeclaration(owner) && owner.parent) owner = owner.parent;
      if (!ts.isFunctionDeclaration(owner) || !owner.name) return false;
      actual.push(`${owner.name.text}:${reference.parent.getText(repo)}`);
    }
    if (actual.sort().join("\n") !== [...expected].sort().join("\n")) return false;
  }
  return owners.size === 4;
}

/** The immutable completion is supplied only by the captured paired runtime.
 * This pins the full owning transaction and final CTE, not caller status or SQL
 * seeded ciphertext. Execution/authentication remains the native gate's job. */
function isFixedStandaloneWriteContext(fn: Fn, repo: ts.SourceFile, owning: ts.FunctionDeclaration,
  query: ts.TemplateExpression, params: ts.ArrayLiteralExpression): boolean {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  return fn.name === "finishStandalone" && owning.parameters.length === 2
    && owning.parameters[0].getText(repo) === "sql:Sql" && owning.parameters[1].getText(repo) === "origin:unknown"
    && hash(owning.getText(repo)) === "a131b4b0d967fe4dffe07a2318341228d6f2f81865fbaca07fbb3698168ba94c"
    && hash(query.getText(repo).slice(1, -1)) === "f03647d6353cad773980d77c7be2ff148a1827f654bd7e996142bc6a5386b045"
    && params.elements.map(item => item.getText(repo)).join("\n") === ["b.workspaceId", "b.operationId", "b.attemptId", "b.holder", "b.fenceToken",
      "JSON.stringify(bound.proof)", "JSON.stringify(sourceAuthority)", "JSON.stringify(productAuthority)", "JSON.stringify(receipt)"].join("\n");
}

/** These are three exact reviewed writes, not a function-name SQL exemption.
 * The hashes bind complete fixed CTE text and original literal clauses; AST
 * provenance separately binds imported symbols, the native frame and parameters.
 * No production module or composer is executed by this source audit. */
function isFixedCleanupWriteContext(fn: Fn, repo: ts.SourceFile, owning: ts.FunctionDeclaration,
  query: ts.TemplateExpression, params: ts.ArrayLiteralExpression): boolean {
  const first = ["input.custody.workspaceId", "input.custody.operationId", "bound.attempt", "input.lease.holder",
    "input.lease.fenceToken", "JSON.stringify({...bound.proof,standaloneSettlements:bound.settlements})", "JSON.stringify(sourceAuthority)", "JSON.stringify(productAuthority)"];
  const contexts: Record<string, { purpose: string; hash: string; functionHash: string; tail: string[]; returned: string }> = {
    // WP5 (schema 61): functionHash changed only by the one call that releases a drained superseded generation
    // before the unchanged hold INSERT, and the one call after the inventory read that releases a refused attempt's own
    // generation. The INSERT text, its parameters and the single authority check are unchanged.
    retainCleanupWriterHold: { purpose: "hold", hash: "83d3c130597d17ff6461f80c21fdc322140b12a46d562d207526af7c8c58b8ed", functionHash: "12f8b6457091856fa999bb4c8c8e4e76ebafe581d9772a2c16b698c28bffe97e",
      tail: ["c.projectId", "c.environmentId", "generation", "bound.manifestDigest", "frame.authorityDigest"], returned: "generation" },
    reserveCleanupOwnerGrant: { purpose: "grant", hash: "30d525a135fb41d74740a3c2048965d8b9290150c8f38158164fff55aad7117b", functionHash: "13fc8a46cded322591360ed4b84e1fe78498e1839431db3e330c1c2d5dc138be",
      tail: ["h.generation", "jti", "frame.authorityDigest"], returned: "jti" },
    insertCleanupOwnerGrant: { purpose: "grant", hash: "8ccca916d1e31d55e9045cea5bed4baabf9faf12207446adafe485b3d9390b68", functionHash: "80f38aae9a6f7393b69711994db297a4a051a49ca5f281d33ac87d3ddf8f9925",
      tail: ["grant.jti", "grant.issuedAt", "grant.expiresAt"], returned: "jti" },
  };
  const context = contexts[fn.name];
  if (!context || owning.parameters[0]?.getText(repo) !== "sql:Sql" || owning.parameters[1]?.getText(repo) !== "origin:unknown"
    || owning.parameters.length !== (fn.name === "retainCleanupWriterHold" ? 2 : 3)) return false;
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  if (hash(owning.getText(repo)) !== context.functionHash || hash(query.getText(repo).slice(1, -1)) !== context.hash
    || params.elements.map(item => item.getText(repo)).join("\n") !== [...first, ...context.tail].join("\n")) return false;
  const walk = (node: ts.Node, test: (node: ts.Node) => boolean): boolean => test(node)
    || (ts.forEachChild(node, child => walk(child, test)) ?? false);
  for (const name of ["readNativeCleanupOrigin", "assertNativeCleanupOriginCurrent"]) {
    const imported: ts.ImportSpecifier[] = [];
    walk(repo, node => { if (ts.isImportSpecifier(node) && node.name.text === name) imported.push(node); return false; });
    if (imported.length !== 1 || imported[0].isTypeOnly || imported[0].propertyName) return false;
    const declaration = imported[0].parent.parent.parent;
    if (!ts.isImportDeclaration(declaration) || declaration.importClause?.isTypeOnly
      || !ts.isStringLiteral(declaration.moduleSpecifier) || declaration.moduleSpecifier.text !== "@/lib/platform/plan-artifacts") return false;
    if (walk(repo, node => (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node)
      || ts.isClassDeclaration(node) || ts.isBindingElement(node)) && !!node.name && ts.isIdentifier(node.name) && node.name.text === name)) return false;
  }
  // Pin the actual private native capture, which locks owner rows before the
  // coordinator and resolves source/product/current policy from owning rows.
  const captures = repo.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === "captureCleanupFrame");
  if (captures.length !== 1 || captures[0].modifiers?.some(node => node.kind === ts.SyntaxKind.ExportKeyword)
    || hash(captures[0].getText(repo)) !== "82191680184982f73c502f7b08a1b8b3970c4637e4253d01045df0c2ac0890a2") return false;
  // A function declaration is a mutable binding. Only the canonical declaration
  // and its three reviewed direct callee sites may reference this private frame;
  // a separate assignment or alias must not inherit declaration-hash authority.
  const captureReferences: ts.Identifier[] = [];
  if (walk(repo, node => {
    if (ts.isIdentifier(node) && node.text === "captureCleanupFrame") captureReferences.push(node);
    return ts.isIdentifier(node) && ["eval", "Function"].includes(node.text);
  }) || captureReferences.length !== 4) return false;
  const captureOwners = new Set<string>();
  for (const reference of captureReferences) {
    if (reference === captures[0].name) continue;
    const call = reference.parent;
    if (!ts.isCallExpression(call) || call.expression !== reference
      || call.getText(repo) !== "captureCleanupFrame(sql,tx,bound)") return false;
    let owner: ts.Node = call;
    while (!ts.isFunctionDeclaration(owner) && owner.parent) owner = owner.parent;
    if (!ts.isFunctionDeclaration(owner) || !owner.name || !Object.hasOwn(contexts, owner.name.text)
      || captureOwners.has(owner.name.text)) return false;
    captureOwners.add(owner.name.text);
  }
  if (captureOwners.size !== 3) return false;
  const literalClauses: Record<string, string> = {
    LIVE_USE_AUTHORITY: "83c59ac088fd79302d4e35ee4be2c92ab61ea180dbdd0ea3134bd2e2d22f0b77",
    DISPATCH_SOURCE_AUTHORITY: "f8e290362c74a3fe7ac1bf511b4f90ace2aaad54b91c8d3e9f2afe5026d8c34c",
  };
  for (const [name, expected] of Object.entries(literalClauses)) {
    const found: ts.VariableDeclaration[] = [];
    walk(repo, node => { if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) found.push(node); return false; });
    if (found.length !== 1 || !found[0].initializer || !ts.isNoSubstitutionTemplateLiteral(found[0].initializer)
      || !ts.isVariableDeclarationList(found[0].parent) || !(found[0].parent.flags & ts.NodeFlags.Const)
      || hash(found[0].initializer.getText(repo)) !== expected) return false;
  }
  const declarations: ts.VariableDeclaration[] = [];
  walk(owning, node => { if (ts.isVariableDeclaration(node)) declarations.push(node); return false; });
  const exact = (name: string, value: string) => declarations.filter(node => ts.isIdentifier(node.name) && node.name.text === name
    && node.initializer?.getText(repo) === value).length === 1;
  if (!exact("bound", `await readNativeCleanupOrigin(origin,sql,"${context.purpose}")`)
    || !exact("frame", "await captureCleanupFrame(sql,tx,bound)") || !exact("input", "bound.access")
    || !exact("sourceAuthority", "frame.source") || !exact("productAuthority", "frame.product")) return false;
  const callbacks: ts.ArrowFunction[] = [];
  walk(owning, node => {
    if (ts.isCallExpression(node) && node.expression.getText(repo) === "sql.tx" && node.arguments.length === 1
      && ts.isArrowFunction(node.arguments[0])) callbacks.push(node.arguments[0]);
    return false;
  });
  const callback = callbacks[0];
  if (callbacks.length !== 1 || callback.parameters.length !== 1 || callback.parameters[0].name.getText(repo) !== "tx"
    || !callback.modifiers?.some(node => node.kind === ts.SyntaxKind.AsyncKeyword) || !ts.isBlock(callback.body)
    || query.pos < callback.pos || query.end > callback.end) return false;
  const beforeQuery = callback.body.statements.filter(node => node.end <= query.pos).map(node => node.getText(repo));
  if (!beforeQuery.includes("const frame=await captureCleanupFrame(sql,tx,bound);")
    || !beforeQuery.includes("await lockCleanupCoordinator(tx,c.workspaceId);")
    || beforeQuery.filter(text => text === "await assertNativeCleanupOriginCurrent(origin,sql);").length !== (fn.name === "retainCleanupWriterHold" ? 1 : 2)
    || beforeQuery.at(-1) !== "const input=bound.access,sourceAuthority=frame.source,productAuthority=frame.product;") return false;
  const suffix = callback.body.statements.filter(node => node.pos >= query.end).map(node => node.getText(repo));
  if (!suffix.includes("if(rows.length!==1)throw new cleanup.CleanupWriterBarrierError();")) return false;
  // No second query or alternate INSERT is admitted through this context.
  const queries: ts.CallExpression[] = [];
  walk(callback, node => { if (ts.isCallExpression(node) && node.expression.getText(repo) === "tx.query") queries.push(node); return false; });
  return queries.length === 1 && queries[0].arguments[0] === query
    && query.getText(repo).includes(`returning ${context.returned}`);
}

/** Source proof for one internal composer; the composer and its imports are never executed. */
function isFixedPlanProductInterpolation(fn: Fn, expression: string, sqlText: string, composerSource: string): boolean {
  if (fn.file !== "plan-artifacts.ts" || !["claim", "dispatch", "retainCleanupWriterHold", "reserveCleanupOwnerGrant", "insertCleanupOwnerGrant", "finishStandalone"].includes(fn.name)
    || expression !== "planProductDispatchPredicate(productAuthority)") return false;
  const parse = parseSource;
  const repo = parse(fn.file, fn.source), composer = parse("plan-artifact-product-authority.ts", composerSource);
  const walk = (node: ts.Node, predicate: (node: ts.Node) => boolean): boolean => {
    if (predicate(node)) return true;
    return ts.forEachChild(node, child => walk(child, predicate)) ?? false;
  };
  // map/join mean the standard builtins. Refuse module-local replacement or
  // an extra opaque initializer/statement; external module/runtime tampering
  // remains outside this bounded source proof.
  const schemaBindings = new Set(["Id", "Hash", "ObjectValue", "Row", "Reconstruction", "Witness"]);
  const schemaMethods = new Set(["string", "regex", "record", "unknown", "object", "passthrough", "nullable", "number", "int", "positive", "literal", "enum", "strict"]);
  const schemaInitializer = (node: ts.Expression): boolean => {
    if (ts.isStringLiteral(node) || ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.RegularExpressionLiteral) return true;
    if (ts.isIdentifier(node)) return schemaBindings.has(node.text);
    if (ts.isArrayLiteralExpression(node)) return node.elements.every(item => ts.isExpression(item) && schemaInitializer(item));
    if (ts.isObjectLiteralExpression(node)) return node.properties.every(item => ts.isPropertyAssignment(item)
      && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && schemaInitializer(item.initializer));
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)
      || !schemaMethods.has(node.expression.name.text) || !node.arguments.every(schemaInitializer)) return false;
    const receiver = node.expression.expression;
    return ts.isIdentifier(receiver) && (receiver.text === "z" || schemaBindings.has(receiver.text))
      || ts.isCallExpression(receiver) && schemaInitializer(receiver);
  };
  if (composer.statements.some(statement => !ts.isImportDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)
    && !ts.isInterfaceDeclaration(statement) && !ts.isFunctionDeclaration(statement) && !ts.isVariableStatement(statement))) return false;
  if (composer.statements.some(statement => ts.isExpressionStatement(statement)
    || ts.isVariableStatement(statement) && (!(statement.declarationList.flags & ts.NodeFlags.Const)
      || statement.declarationList.declarations.some(item => !ts.isIdentifier(item.name) || !item.initializer
        || item.name.text !== "tableNames" && item.name.text !== "refuse"
          && (!schemaBindings.has(item.name.text) || !schemaInitializer(item.initializer))
        || item.name.text === "refuse" && !ts.isArrowFunction(item.initializer))))
    || walk(composer, node => ts.isIdentifier(node) && ["Array", "globalThis", "eval", "Function"].includes(node.text)
      || ts.isPropertyAccessExpression(node) && ["prototype", "getPrototypeOf", "setPrototypeOf", "defineProperty", "defineProperties"].includes(node.name.text)
      || ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Reflect"
        && ["set", "deleteProperty"].includes(node.name.text))) return false;
  const imports = repo.statements.filter(ts.isImportDeclaration).filter(node => ts.isStringLiteral(node.moduleSpecifier)
    && node.moduleSpecifier.text === "./plan-artifact-product-authority" && !node.importClause?.isTypeOnly
    && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
    && node.importClause.namedBindings.elements.some(item => !item.isTypeOnly && !item.propertyName && item.name.text === "planProductDispatchPredicate"));
  const importedBindings: ts.ImportSpecifier[] = [];
  walk(repo, node => {
    if (ts.isImportSpecifier(node) && node.name.text === "planProductDispatchPredicate") importedBindings.push(node);
    return false;
  });
  if (imports.length !== 1 || importedBindings.length !== 1 || walk(repo, node => (ts.isVariableDeclaration(node) || ts.isParameter(node)
    || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node) || ts.isBindingElement(node)) && !!node.name
    && ts.isIdentifier(node.name) && node.name.text === "planProductDispatchPredicate")) return false;
  const owning = repo.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === fn.name);
  if (owning.length !== 1 || !owning[0].body || !fn.body.trimStart().startsWith(owning[0].getText(repo))) return false;
  if (fn.name !== "claim" && !fixedStandaloneBindings(repo)) return false;
  // The dispatch proof also includes authenticated settlements. Pin its full
  // original transaction and exact current-authority parameter binding.
  if (fn.name === "dispatch" && createHash("sha256").update(owning[0].getText(repo)).digest("hex")
    !== "886af56bbc56385b2ef1e98c6c43eeefeb75adc5ad3b84a62b5b534fbf44059b") return false;
  // Bind this call to the actual owning update, tenant parameters and JSON $8 input.
  const queryMatches: ts.CallExpression[] = [];
  walk(owning[0], node => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)
      || !ts.isIdentifier(node.expression.expression) || node.expression.expression.text !== "tx"
      || node.expression.name.text !== "query" || node.arguments.length !== 2) return false;
    const [query, params] = node.arguments;
    if (!ts.isTemplateExpression(query) || query.getText(repo) !== "`" + sqlText + "`"
      || !ts.isArrayLiteralExpression(params)) return false;
    const calls = query.templateSpans.filter(span => span.expression.getText(repo) === expression);
    const head = query.head.text;
    const cleanupWrite = !["claim", "dispatch"].includes(fn.name);
    if (cleanupWrite && !(fn.name === "finishStandalone"
      ? isFixedStandaloneWriteContext(fn, repo, owning[0], query, params)
      : isFixedCleanupWriteContext(fn, repo, owning[0], query, params))) return false;
    if (fn.name === "dispatch" && (createHash("sha256").update(query.getText(repo).slice(1, -1)).digest("hex")
      !== "b8bef17ce02cc72e49598efe453bd60dc2369d0b83c812898ca033691e9bd190"
      || params.elements[5].getText(repo) !== "authority?JSON.stringify({...authority,standaloneSettlements:settled}):null")) return false;
    if (calls.length !== 1 || !cleanupWrite && (params.elements.length !== 8 || !head.startsWith(`update platform.plan_artifact_uses set phase='${fn.name === "claim" ? "claimed" : "dispatched"}'`)
      || !head.includes(`where workspace_id=$1 and operation_id=$2 and phase='${fn.name === "claim" ? "ready" : "claimed"}'`)
      || params.elements[0].getText(repo) !== "input.custody.workspaceId"
      || params.elements[1].getText(repo) !== "input.custody.operationId"
      || params.elements[7].getText(repo) !== "JSON.stringify(productAuthority)")) return false;
    const spanIndex = query.templateSpans.indexOf(calls[0]);
    const before = spanIndex === 0 ? query.head.text : query.templateSpans[spanIndex - 1].literal.text;
    if (!/\band\s*\($/.test(before) || !calls[0].literal.text.startsWith(")")) return false;
    const call = calls[0].expression;
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== "planProductDispatchPredicate"
      || call.arguments.length !== 1 || !ts.isIdentifier(call.arguments[0]) || call.arguments[0].text !== "productAuthority") return false;
    queryMatches.push(node);
    return false;
  });
  if (queryMatches.length !== 1) return false;

  const tableDeclarations: ts.VariableDeclaration[] = [];
  walk(composer, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "tableNames") tableDeclarations.push(node);
    return false;
  });
  if (tableDeclarations.length !== 1) return false;
  const table = tableDeclarations[0], list = table.initializer;
  const canonicalTables = ["workspaces", "members", "projects", "environments", "revisions", "revision_manifests", "deployments", "connections"];
  if (!ts.isVariableDeclarationList(table.parent) || !(table.parent.flags & ts.NodeFlags.Const)
    || table.parent.declarations.length !== 1 || !ts.isVariableStatement(table.parent.parent) || table.parent.parent.parent !== composer
    || table.parent.parent.modifiers?.some(node => node.kind === ts.SyntaxKind.ExportKeyword)
    || !list || !ts.isAsExpression(list) || list.type.getText(composer) !== "const"
    || !ts.isArrayLiteralExpression(list.expression) || list.expression.elements.length !== canonicalTables.length
    || list.expression.elements.some((item, index) => !ts.isStringLiteral(item) || item.text !== canonicalTables[index])) return false;
  // Refuse writes, escapes/aliases or different method calls anywhere in this module.
  const tableMaps: ts.CallExpression[] = [];
  if (walk(composer, node => {
    if (!ts.isIdentifier(node) || node.text !== "tableNames") return false;
    if (node === table.name || ts.isTypeQueryNode(node.parent)) return false;
    const property = node.parent, call = property.parent;
    if (!ts.isPropertyAccessExpression(property) || property.expression !== node || !ts.isCallExpression(call) || call.expression !== property) return true;
    if (property.name.text === "map") tableMaps.push(call);
    return !["map", "some"].includes(property.name.text)
      || property.name.text === "some" && call.getText(composer) !== "tableNames.some(name => !tables[name])";
  }) || tableMaps.length !== 1) return false;

  const functions = composer.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === "planProductDispatchPredicate");
  const declaration = functions[0];
  if (functions.length !== 1 || !declaration.body || declaration.parameters.length !== 1
    || declaration.parameters[0].name.getText(composer) !== "current"
    || declaration.parameters[0].type?.getText(composer) !== "PlanProductDispatchAuthority"
    || declaration.type?.kind !== ts.SyntaxKind.StringKeyword
    || !declaration.modifiers?.some(node => node.kind === ts.SyntaxKind.ExportKeyword)
    || tableMaps[0].pos < declaration.pos || tableMaps[0].end > declaration.end) return false;
  const selectors = new Set(["current.tables.workspaces", "current.tables.projects", "current.tables.environments", "current.tables.members",
    "current.currentRequirement?.nativeCredential", "current.currentRequirement?.nativeOAuthGrant", "current.currentRequirement"]);
  const stringOnly = (node: ts.Expression, bindings: Set<string>, names = new Set<string>()): boolean => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true;
    if (ts.isIdentifier(node)) return bindings.has(node.text) || names.has(node.text);
    if (ts.isTemplateExpression(node)) return node.templateSpans.every(span => stringOnly(span.expression, bindings, names));
    if (ts.isConditionalExpression(node)) return selectors.has(node.condition.getText(composer))
      && stringOnly(node.whenTrue, bindings, names) && stringOnly(node.whenFalse, bindings, names);
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "join"
      || node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]) || node.arguments[0].text !== " and ") return false;
    const collection = node.expression.expression;
    if (ts.isArrayLiteralExpression(collection)) return collection.elements.every(item => ts.isExpression(item) && stringOnly(item, bindings, names));
    if (!ts.isCallExpression(collection) || !ts.isPropertyAccessExpression(collection.expression)
      || !ts.isIdentifier(collection.expression.expression) || collection.expression.expression.text !== "tableNames"
      || collection.expression.name.text !== "map" || collection.arguments.length !== 1) return false;
    const callback = collection.arguments[0];
    return ts.isArrowFunction(callback) && !callback.modifiers && callback.parameters.length === 1
      && ts.isIdentifier(callback.parameters[0].name) && !callback.parameters[0].initializer
      && ts.isTemplateExpression(callback.body)
      && stringOnly(callback.body, new Set(), new Set([callback.parameters[0].name.text]));
  };
  const fixedBlock = (block: ts.Block, incoming: Set<string>): boolean => {
    const bindings = new Set(incoming);
    return block.statements.every(statement => {
      if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const)) {
        return statement.declarationList.declarations.every(item => {
          if (!ts.isIdentifier(item.name) || bindings.has(item.name.text) || !item.initializer || !stringOnly(item.initializer, bindings)) return false;
          bindings.add(item.name.text);
          return true;
        });
      }
      if (ts.isReturnStatement(statement)) return !!statement.expression && stringOnly(statement.expression, bindings);
      return ts.isIfStatement(statement) && statement.expression.getText(composer) === 'current.kind === "native-absence"'
        && !statement.elseStatement && ts.isBlock(statement.thenStatement) && fixedBlock(statement.thenStatement, bindings);
    });
  };
  return fixedBlock(declaration.body, new Set()) && ts.isReturnStatement(declaration.body.statements.at(-1)!);
}

/**
 * Functions that touch a tenant table WITHOUT a workspace predicate on purpose,
 * each with the reason. Mirrors EXEMPT in tests/controlplane/tenancy.test.ts —
 * a new entry here needs a security review, not just a reason.
 */
const UNSCOPED: Record<string, string> = {
  "managedServing.listRevokePending": "system-only revocation inventory under the managed-serving lease; rows carry their owning workspace and settlement rebinds key.workspaceId (domain-store.test.ts)",
  "plugins.hasGrantTokenHash": "authentication discriminator keyed by a high-entropy token digest; returns only existence before live audience-bound grant authentication (launch-integration.test.ts)",
  "leases.acquire": "keyed by a globally unique scope string; a workspace-tagged scope refuses a foreign workspace",
  "leases.renew": "keyed by scope + holder + fence",
  "leases.release": "keyed by scope + holder + fence",
  "leases.current": "keyed by scope",
  "leases.assertFence": "keyed by scope + fence",
  "nonces.remember": "keyed by agent id (globally unique); never read by tenants",
  "nonces.prune": "system maintenance",
  "idempotency.prune": "system maintenance",
  "operations.markUncertainExpired": "system reconciler; every returned record carries its workspace",
  "operations.expireOverdue": "system reconciler",
  "jobs.expireStale": "system reaper",
  "runners.consumeRegistrationToken": "keyed by the token hash; the workspace comes FROM the token",
  "runners.registerRunner": "the workspace comes from the registration token, never from the caller",
  "machines.registerMachine": "the workspace comes from the registration token, never from the caller",
  "runners.findRunnerForAuth": "the one documented unscoped lookup: a signed request names only the agent id",
  "machines.findMachineForAuth": "the one documented unscoped lookup: a signed request names only the machine id",
  "externalEffects.sweepStalePending": "system maintenance under the housekeeping lease: declares pending effects whose dispatcher vanished uncertain (never retried); every returned row carries its workspace and nothing is read from tenant input",
  "optimizerSettings.listOptedInEnvironments": "system scheduler only: returns (workspace, environment) pairs that opted in; every later call uses the returned workspace",
  "operations.getForSystem": "execution worker only: a workflow carries just the operation id; every later call uses the workspace of the returned row (callers pinned below)",
};

describe("control-store repositories: workspace scoping is present in every function that touches a tenant table", () => {
  const tables = tenantTables();
  const files = readdirSync(REPOS).filter((f) => f.endsWith(".ts") && f !== "index.ts");
  const fns = files.flatMap(functionsOf);
  const touches = (fn: Fn) => tables.filter((t) => new RegExp(`platform\\.${t}\\b`).test(fn.body));
  const key = (fn: Fn) => `${fn.file.replace(/\.ts$/, "").replace(/-(\w)/g, (_m, c: string) => c.toUpperCase())}.${fn.name}`;

  it("finds the tenant tables and the repository functions this audit is about (so it cannot pass by reading nothing)", () => {
    expect(tables.length).toBeGreaterThanOrEqual(20);
    expect(tables).toEqual(expect.arrayContaining(["operations", "approvals", "capability_grants", "events", "runners", "resources", "provider_connections", "incidents"]));
    expect(fns.length).toBeGreaterThan(80);
    expect(fns.filter((f) => touches(f).length > 0).length).toBeGreaterThan(50);
  });

  it("every function touching a tenant table names workspace_id, or is on the reviewed exemption list", () => {
    const offenders: string[] = [];
    for (const fn of fns) {
      const hit = touches(fn);
      if (hit.length === 0) continue;
      // the SQL column, not the TypeScript parameter: `workspaceId` in a signature proves nothing about the query
      if (/\bworkspace_id\b/.test(fn.body)) continue;
      if (key(fn) in UNSCOPED) continue;
      offenders.push(`${key(fn)} touches ${hit.join(", ")} but never mentions workspace_id`);
    }
    expect(offenders, "SECURITY INVARIANT (tenancy in SQL): scope these queries by workspace_id or add a reviewed entry to UNSCOPED with its reason").toEqual([]);
  });

  it("operations.getForSystem is called only by the execution worker's platform ports (never from a tenant-facing path)", () => {
    const callers: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && readFileSync(p, "utf8").includes("getForSystem")) callers.push(path.relative(process.cwd(), p).split(path.sep).join("/"));
      }
    };
    walk(path.join(process.cwd(), "src"));
    expect(callers.filter((f) => !f.startsWith("src/lib/controlplane/")).sort()).toEqual(["src/lib/execution/platform.ts"]);
  });

  it("every UNSCOPED entry still exists (a stale exemption would hide a future function of the same name)", () => {
    const names = new Set(fns.map(key));
    for (const entry of Object.keys(UNSCOPED)) expect(names.has(entry), `${entry} no longer exists; remove its exemption`).toBe(true);
  });

  it("keeps pending storage-key discovery in the system job and rebinds settlement to each row's workspace", () => {
    const callers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (/\.tsx?$/.test(entry.name) && readFileSync(file, "utf8").includes("listRevokePending")) callers.push(path.relative(process.cwd(), file).split(path.sep).join("/"));
      }
    };
    walk(path.join(process.cwd(), "src"));
    expect(callers.filter(file => !file.startsWith("src/lib/controlplane/")).sort()).toEqual(["src/lib/managed-serving/job.ts"]);
    const job = readFileSync(path.join(process.cwd(), "src/lib/managed-serving/job.ts"), "utf8");
    expect(job).toContain("markStorageKeyRevoked(db, key.workspaceId, key.id, now)");
  });

  it("SQL that carries a tenant id takes it as a bound parameter, never by string concatenation", () => {
    const start = fns.find(fn => fn.file === "workflow-start-intents.ts" && fn.name === "get")!;
    expect(isFixedStartAuthorityInterpolation(start, "currentAuthority", "where ")).toBe(true);
    expect(isFixedStartAuthorityInterpolation(start, "bindingParam", "$")).toBe(true);
    expect(isFixedStartAuthorityInterpolation(start, "bindingParam + 1", "$")).toBe(true);
    expect(isFixedStartAuthorityInterpolation(start, "bindingParam", "where tenant=")).toBe(false);
    expect(isFixedStartAuthorityInterpolation(start, "bindingParam + offset", "$")).toBe(false);
    expect(isFixedStartAuthorityInterpolation({ ...start, body: start.body.replace("source ? 13 : 12", "source ? callerValue : 12") }, "bindingParam", "$")).toBe(false);
    expect(isFixedStartAuthorityInterpolation({ ...start, body: start.body.replace("`${LIVE_AUTHORITY}${source ? ` and ${MCP_DEPLOY_AUTHORITY}` : \"\"}`", "callerValue") }, "currentAuthority", "where ")).toBe(false);
    expect(isFixedStartAuthorityInterpolation({ ...start, source: start.source.replace("const LIVE_AUTHORITY = `", "const LIVE_AUTHORITY = `${callerValue}") }, "currentAuthority", "where ")).toBe(false);
    expect(isFixedStartAuthorityInterpolation({ ...start, file: "another-repository.ts" }, "bindingParam", "$")).toBe(false);
    const composerSource = readFileSync(path.join(REPOS, "plan-artifact-product-authority.ts"), "utf8");
    const native = fns.filter(fn => fn.file === "plan-artifacts.ts" && ["claim", "dispatch"].includes(fn.name));
    expect(native.map(fn => fn.name).sort()).toEqual(["claim", "dispatch"]);
    for (const fn of native) {
      const query = [...fn.body.matchAll(/\.query(?:<[^>]*>)?\(\s*`([\s\S]*?)`/g)]
        .find(match => match[1].includes("${planProductDispatchPredicate(productAuthority)}"))![1];
      const expression = "planProductDispatchPredicate(productAuthority)";
      expect(isFixedPlanProductInterpolation(fn, expression, query, composerSource), fn.name).toBe(true);
      const hostileComposers: [string, string][] = [
        ["raw current value", composerSource.replace("return `${base} and ${tables}", "return `${current.witness.id} and ${tables}")],
        ["runtime call", composerSource.replace("return `${base} and ${tables}", "return `${String(current.witness.id)} and ${tables}")],
        ["dynamic identifier", composerSource.replace('${name}', '${current.witness.id}')],
        ["changed literal identifier", composerSource.replace('["workspaces", "members"', '["workspaces;drop table public.members", "members"')],
        ["dynamic list member", composerSource.replace('["workspaces", "members"', '[current.witness.id, "members"')],
        ["mutable list declaration", composerSource.replace('const tableNames =', 'let tableNames =')],
        ["list push", composerSource + '\ntableNames.push("unreviewed" as never);\n'],
        ["list index write", composerSource + '\ntableNames[0] = "unreviewed" as never;\n'],
        ["list alias escape", composerSource + '\nconst escaped = tableNames;\n'],
        ["extra map escape", composerSource + '\ntableNames.map((_, __, list) => list.reverse());\n'],
        ["mapped runtime call", composerSource.replace('${name}', '${String(name)}')],
        ["dynamic join", composerSource.replace('.join(" and ")', '.join(current.witness.id)')],
        ["selector runtime call", composerSource.replace('current.currentRequirement ? `', 'getCurrentRequirement() ? `')],
        ["OAuth selector runtime call", composerSource.replace('current.currentRequirement?.nativeOAuthGrant ? `', 'getCurrentOAuthGrant() ? `')],
        ["raw OAuth tuple interpolation", composerSource.replace("g.integration_id=$8::text::jsonb->'currentRequirement'->'operation'->'principal'->>'id'", "g.integration_id=${current.currentRequirement.nativeOAuthGrant.integration_id}")],
        ["OAuth branch runtime interpolation", composerSource.replace("g.integration_id=$8::text::jsonb->'currentRequirement'->'operation'->'principal'->>'id'", "g.integration_id=${String(current.currentRequirement.nativeOAuthGrant.integration_id)}")],
        ["composer side effect", composerSource.replace('  const base = `exists', '  execute(current);\n  const base = `exists')],
        ["prototype map replacement", composerSource + '\nArray.prototype.map = () => [callerControlledSql];\n'],
        ["prototype join replacement", composerSource + '\nObject.defineProperty(Array.prototype, "join", { value: () => callerControlledSql });\n'],
        ["prototype receiver alias", composerSource + '\nconst target = Object.getPrototypeOf([]); target.map = caller;\n'],
        ["reflect prototype replacement", composerSource + '\nReflect.set(Array.prototype, "map", caller);\n'],
        ["opaque module statement", composerSource + '\npatchStandardBuiltins();\n'],
        ["opaque module initializer", composerSource + '\nconst initialized = patchStandardBuiltins();\n'],
        ["opaque schema initializer", composerSource.replace('z.record(z.string(), z.unknown())', 'patchStandardBuiltins()')],
        ["nested prototype replacement", composerSource + '\nfunction patch() { Array.prototype.map = caller; }\n'],
        ["conditional opaque module effect", composerSource + '\nif (true) patchStandardBuiltins();\n'],
        ["class static module effect", composerSource + '\nclass Patch { static value = patchStandardBuiltins(); }\n'],
      ];
      for (const [label, source] of hostileComposers) {
        expect(source, label).not.toBe(composerSource);
        expect(isFixedPlanProductInterpolation(fn, expression, query, source), `${fn.name}: ${label}`).toBe(false);
      }
      const changedRepo = (from: string, to: string): Fn => {
        expect(fn.source).toContain(from);
        return { ...fn, source: fn.source.replaceAll(from, to), body: fn.body.replaceAll(from, to) };
      };
      expect(isFixedPlanProductInterpolation(changedRepo('from "./plan-artifact-product-authority"', 'from "./foreign-composer"'), expression, query, composerSource)).toBe(false);
      expect(isFixedPlanProductInterpolation(changedRepo('planProductDispatchPredicate, type', 'foreignPredicate as planProductDispatchPredicate, type'), expression, query, composerSource)).toBe(false);
      expect(isFixedPlanProductInterpolation({ ...fn, source: fn.source + '\nimport { other as planProductDispatchPredicate } from "./foreign-composer";\n' }, expression, query, composerSource)).toBe(false);
      expect(isFixedPlanProductInterpolation(changedRepo('let productAuthority: PlanProductDispatchAuthority;', 'const planProductDispatchPredicate = caller; let productAuthority: PlanProductDispatchAuthority;'), expression, query, composerSource)).toBe(false);
      expect(isFixedPlanProductInterpolation({ ...fn, file: "foreign-repository.ts" }, expression, query, composerSource)).toBe(false);
      expect(isFixedPlanProductInterpolation({ ...fn, name: "read" }, expression, query, composerSource)).toBe(false);
      const foreignTable = query.replace("update platform.plan_artifact_uses", "update public.deployments");
      expect(isFixedPlanProductInterpolation(changedRepo(query, foreignTable), expression, foreignTable, composerSource)).toBe(false);
      const foreignScope = query.replace("where workspace_id=$1 and operation_id=$2", "where workspace_id=$9 and operation_id=$2");
      expect(isFixedPlanProductInterpolation(changedRepo(query, foreignScope), expression, foreignScope, composerSource)).toBe(false);
      const valuePosition = query.replace("and (${planProductDispatchPredicate(productAuthority)})", "and witness=${planProductDispatchPredicate(productAuthority)}");
      expect(isFixedPlanProductInterpolation(changedRepo(query, valuePosition), expression, valuePosition, composerSource)).toBe(false);
      expect(isFixedPlanProductInterpolation(changedRepo("[input.custody.workspaceId,input.custody.operationId,attemptId", "[input.workspaceId,input.custody.operationId,attemptId"), expression, query, composerSource)).toBe(false);
      expect(isFixedPlanProductInterpolation(changedRepo("JSON.stringify(productAuthority)", "JSON.stringify(input)"), expression, query, composerSource)).toBe(false);
      const directValue = query.replace("planProductDispatchPredicate(productAuthority)", "productAuthority.witness.id");
      expect(isFixedPlanProductInterpolation(changedRepo(query, directValue), "productAuthority.witness.id", directValue, composerSource)).toBe(false);
    }
    const cleanupWrites = fns.filter(fn => fn.file === "plan-artifacts.ts"
      && ["retainCleanupWriterHold", "reserveCleanupOwnerGrant", "insertCleanupOwnerGrant"].includes(fn.name));
    expect(cleanupWrites.map(fn => fn.name)).toEqual(["retainCleanupWriterHold", "reserveCleanupOwnerGrant", "insertCleanupOwnerGrant"]);
    for (const fn of cleanupWrites) {
      const query = [...fn.body.matchAll(/\.query(?:<[^>]*>)?\(\s*`([\s\S]*?)`/g)]
        .find(match => match[1].includes("${planProductDispatchPredicate(productAuthority)}"))![1];
      const expression = "planProductDispatchPredicate(productAuthority)";
      expect(isFixedPlanProductInterpolation(fn, expression, query, composerSource), fn.name).toBe(true);
      const changed = (from: string, to: string): Fn => {
        expect(fn.source, `${fn.name}: mutation must reach source`).toContain(from);
        return { ...fn, source: fn.source.replaceAll(from, to), body: fn.body.replaceAll(from, to) };
      };
      const changedQuery = (from: string, to: string): void => {
        expect(query, `${fn.name}: mutation must reach SQL`).toContain(from);
        const replacement = query.replaceAll(from, to);
        expect(isFixedPlanProductInterpolation(changed(query, replacement), expression, replacement, composerSource), `${fn.name}: ${from}`).toBe(false);
      };
      for (const [from, to] of [
        ["set updated_at=updated_at", "set phase='dispatched'"],
        ["workspace_id=$1 and operation_id=$2", "workspace_id=$9 and operation_id=$2"],
        ["phase='claimed'", "phase='ready'"],
        ["from authority where operation_id=$2", "from authority where true"],
        ["and (${planProductDispatchPredicate(productAuthority)})", "and witness=${planProductDispatchPredicate(productAuthority)}"],
        ["planProductDispatchPredicate(productAuthority)", "productAuthority.witness.id"],
        ["and (${LIVE_USE_AUTHORITY})", "and true"],
        ["and (${DISPATCH_SOURCE_AUTHORITY})", "and true"],
        ["a.consumed_at is not null", "true"],
      ]) changedQuery(from, to);
      const target = /insert into platform\.(\w+)/.exec(query)![1];
      changedQuery(`insert into platform.${target}`, "insert into public.unreviewed_effects");
      changedQuery("select $", "values ($");
      for (const [from, to] of [
        ['from "@/lib/platform/plan-artifacts"', 'from "./untrusted-cleanup-origin"'],
        ['readNativeCleanupOrigin, assertNativeCleanupOriginCurrent', 'foreignOrigin as readNativeCleanupOrigin, assertNativeCleanupOriginCurrent'],
        ['const bound=await readNativeCleanupOrigin(origin,sql,', 'const bound=await callerCleanupDto(origin,sql,'],
        ['const frame=await captureCleanupFrame(sql,tx,bound);', 'const frame=callerFrame;'],
        ['const input=bound.access,sourceAuthority=frame.source,productAuthority=frame.product;', 'const input=bound.access,sourceAuthority=frame.source,productAuthority=callerProduct;'],
        ['const input=bound.access,sourceAuthority=frame.source,productAuthority=frame.product;', 'let input=bound.access,sourceAuthority=frame.source,productAuthority=frame.product;'],
        ['JSON.stringify({...bound.proof,standaloneSettlements:bound.settlements})', 'JSON.stringify(callerApproval)'],
        ['JSON.stringify(sourceAuthority)', 'JSON.stringify(input)'],
        ['JSON.stringify(productAuthority)', 'JSON.stringify(input)'],
        ['[input.custody.workspaceId,input.custody.operationId,bound.attempt', '[input.workspaceId,input.custody.operationId,bound.attempt'],
        ['[input.custody.workspaceId,input.custody.operationId,bound.attempt', '[input.custody.workspaceId,input.custody.operationId,callerAttempt'],
        ['await lockCleanupCoordinator(tx,c.workspaceId);', 'await lockCleanupCoordinator(tx,callerWorkspace);'],
        ['if(rows.length!==1)throw new cleanup.CleanupWriterBarrierError();', 'if(rows.length!==1)return;'],
      ]) expect(isFixedPlanProductInterpolation(changed(from, to), expression, query, composerSource), `${fn.name}: ${from}`).toBe(false);
      for (const effect of [
        '\ncaptureCleanupFrame = callerFrameFactory;\n',
        '\nconst escapedNativeFrame = captureCleanupFrame;\n',
        '\ncaptureCleanupFrame(sql,tx,bound);\n',
        '\neval("captureCleanupFrame = callerFrameFactory");\n',
      ]) expect(isFixedPlanProductInterpolation({ ...fn, source: fn.source + effect }, expression, query, composerSource), `${fn.name}: private capture mutation`).toBe(false);
      expect(isFixedPlanProductInterpolation({ ...fn, source: fn.source + '\nconst readNativeCleanupOrigin = caller;\n' }, expression, query, composerSource)).toBe(false);
      expect(isFixedPlanProductInterpolation({ ...fn, file: "foreign-repository.ts" }, expression, query, composerSource)).toBe(false);
      expect(isFixedPlanProductInterpolation({ ...fn, name: "callerCleanupWrite" }, expression, query, composerSource)).toBe(false);
      for (const source of [
        composerSource.replace("return `${base} and ${tables}", "return `${current.witness.id} and ${tables}"),
        composerSource.replace('${name}', '${String(current.witness.id)}'),
        composerSource + '\ntableNames.push("unreviewed" as never);\n',
        composerSource + '\nArray.prototype.map = () => [callerControlledSql];\n',
      ]) { expect(source).not.toBe(composerSource); expect(isFixedPlanProductInterpolation(fn, expression, query, source)).toBe(false); }
    }
    const completed = fns.filter(fn => fn.file === "plan-artifacts.ts" && fn.name === "finishStandalone");
    expect(completed.map(fn => fn.name)).toEqual(["finishStandalone"]);
    const settlementContexts = [...native.filter(fn => fn.name === "dispatch"), ...cleanupWrites, ...completed];
    for (const fn of settlementContexts) {
      const query = [...fn.body.matchAll(/\.query(?:<[^>]*>)?\(\s*`([\s\S]*?)`/g)]
        .find(match => match[1].includes("${planProductDispatchPredicate(productAuthority)}"))![1];
      const expression = "planProductDispatchPredicate(productAuthority)";
      expect(isFixedPlanProductInterpolation(fn, expression, query, composerSource), `${fn.name}: settlement context`).toBe(true);
      const changed = (from: string, to: string): Fn => {
        expect(fn.source, `${fn.name}: mutation must reach source`).toContain(from);
        return { ...fn, source: fn.source.replaceAll(from, to), body: fn.body.replaceAll(from, to) };
      };
      for (const [label, from, to] of [
        ["mutable settlement clause", "const LIVE_STANDALONE_SETTLEMENTS=", "let LIVE_STANDALONE_SETTLEMENTS="],
        ["raw settlement tuple", "r.workspace_id=settled->'receipt'->'binding'->>'workspaceId'", "r.workspace_id=${callerWorkspace}"],
        ["foreign immutable settlement owner", "r.workspace_id=$1", "r.workspace_id=$9"],
        ["foreign backend owner", "backend.workspace_id=$1", "backend.workspace_id=$9"],
        ["foreign origin import", 'from "@/lib/platform/plan-artifacts"', 'from "./caller-settlement-origin"'],
        ["aliased standalone origin", "readNativeStandaloneOrigin, assertNativeStandaloneOriginCurrent", "callerOrigin as readNativeStandaloneOrigin, assertNativeStandaloneOriginCurrent"],
        ["aliased current standalone origin", "assertNativeStandaloneOriginCurrent, type NativeCleanupOrigin", "callerCurrent as assertNativeStandaloneOriginCurrent, type NativeCleanupOrigin"],
      ]) {
        // A backend owner predicate is present only in the completion CTE.
        if (label === "foreign backend owner" && fn.name !== "finishStandalone") continue;
        const mutated = changed(from, to);
        const replacement = query.replaceAll(from, to);
        expect(isFixedPlanProductInterpolation(mutated, expression, replacement, composerSource), `${fn.name}: ${label}`).toBe(false);
      }
      for (const [label, effect] of [
        ["settlement clause assignment", "\nLIVE_STANDALONE_SETTLEMENTS = callerSql;\n"],
        ["settlement clause alias", "\nconst escapedSettlements = LIVE_STANDALONE_SETTLEMENTS;\n"],
        ["extra settlement reference", "\nconsume(LIVE_STANDALONE_SETTLEMENTS);\n"],
        ["standalone origin alias", "\nconst escapedOrigin = readNativeStandaloneOrigin;\n"],
        ["standalone origin assignment", "\nreadNativeStandaloneOrigin = callerOrigin;\n"],
        ["extra standalone origin call", '\nreadNativeStandaloneOrigin(caller,sql,"completion");\n'],
        ["current origin alias", "\nconst escapedCurrent = assertNativeStandaloneOriginCurrent;\n"],
        ["current origin assignment", "\nassertNativeStandaloneOriginCurrent = caller;\n"],
        ["dynamic settlement mutation", '\neval("LIVE_STANDALONE_SETTLEMENTS = callerSql");\n'],
        ["dynamic origin mutation", '\nFunction("readNativeStandaloneOrigin = caller")();\n'],
      ]) expect(isFixedPlanProductInterpolation({ ...fn, source: fn.source + effect }, expression, query, composerSource), `${fn.name}: ${label}`).toBe(false);
    }
    for (const fn of completed) {
      const query = [...fn.body.matchAll(/\.query(?:<[^>]*>)?\(\s*`([\s\S]*?)`/g)]
        .find(match => match[1].includes("${planProductDispatchPredicate(productAuthority)}"))![1];
      const expression = "planProductDispatchPredicate(productAuthority)";
      const changed = (from: string, to: string): Fn => {
        expect(fn.source, "completion mutation must reach source").toContain(from);
        return { ...fn, source: fn.source.replaceAll(from, to), body: fn.body.replaceAll(from, to) };
      };
      for (const [from, to] of [
        ['readNativeStandaloneOrigin(origin,sql,"completion")', 'callerReceipt(origin,sql)'],
        ["const input=captureArtifactAccess(bound.access),b=bound.binding;", "const input=captureArtifactAccess(caller.access),b=caller.binding;"],
        ["JSON.stringify(receipt)", "JSON.stringify(callerReceipt)"],
        ["JSON.stringify(bound.proof)", "JSON.stringify(callerApproval)"],
        ["JSON.stringify(sourceAuthority)", "JSON.stringify(input)"],
        ["JSON.stringify(productAuthority)", "JSON.stringify(input)"],
        ["[b.workspaceId,b.operationId,b.attemptId,b.holder,b.fenceToken,JSON.stringify(bound.proof)", "[callerWorkspace,b.operationId,b.attemptId,b.holder,b.fenceToken,JSON.stringify(bound.proof)"],
        ["await lockCleanupCoordinator(tx,b.workspaceId);", "await lockCleanupCoordinator(tx,callerWorkspace);"],
        ["await assertNativeStandaloneOriginCurrent(origin,sql);", "await callerCurrent(origin,sql);"],
        ["if(changed.length!==1)refuse();", "if(changed.length!==1)return;"],
      ]) expect(isFixedPlanProductInterpolation(changed(from, to), expression, query, composerSource), `completion: ${from}`).toBe(false);
      for (const [from, to] of [
        ["set phase='succeeded'", "set phase='ready'"],
        ["workspace_id=$1 and operation_id=$2", "workspace_id=$9 and operation_id=$2"],
        ["phase='dispatched'", "phase='claimed'"],
        ["attempt_id=$3", "attempt_id=$9"],
        ["and (${LIVE_USE_AUTHORITY})", "and true"],
        ["and (${DISPATCH_SOURCE_AUTHORITY})", "and true"],
        ["and (${planProductDispatchPredicate(productAuthority)})", "and witness=${planProductDispatchPredicate(productAuthority)}"],
        ["backend.workspace_id=$1", "backend.workspace_id=$9"],
        ["backend.project_id=$9::text::jsonb->'binding'->>'projectId'", "true"],
        ["backend.environment_id=$9::text::jsonb->'binding'->>'environmentId'", "true"],
        ["backend.backend_digest=$9::text::jsonb->'binding'->>'backendDigest'", "true"],
        ["insert into platform.standalone_plan_settlements", "insert into public.unreviewed_effects"],
        ["from authority returning operation_id", "from caller_rows returning operation_id"],
        ["$9::text::jsonb->'sealed'->>'ciphertext'", "${callerCiphertext}"],
      ]) {
        expect(query, "completion mutation must reach SQL").toContain(from);
        const replacement = query.replaceAll(from, to);
        expect(isFixedPlanProductInterpolation(changed(query, replacement), expression, replacement, composerSource), `completion: ${from}`).toBe(false);
      }
      // Completion binds the original private approval snapshot in the actual
      // atomic write, after every owning lock/coordinator wait. Optional proof
      // or a dropped human-approval clause cannot retain this source admission.
      const approvalStart = query.indexOf("and $6::text::jsonb is not null and exists (");
      const approvalEnd = query.indexOf("\n      and exists(select 1 from platform.standalone_plan_backends", approvalStart);
      expect(approvalStart).toBeGreaterThanOrEqual(0);
      expect(approvalEnd).toBeGreaterThan(approvalStart);
      const approvalGuard = query.slice(approvalStart, approvalEnd);
      const nullableGuard = approvalGuard.replace("and $6::text::jsonb is not null and exists (", "and ($6::text::jsonb is null or exists (") + ")";
      for (const [label, from, to] of [
        ["nullable completion snapshot", approvalGuard, nullableGuard],
        ["removed completion snapshot", approvalGuard, "and true"],
        ["foreign approval owner", "o.workspace_id=$1 and o.id=$2", "o.workspace_id=$9 and o.id=$2"],
        ["dropped approval round", "o.approval_round=($6::text::jsonb->>'approvalRound')::integer", "true"],
        ["different proposal digest", "o.proposal_digest=$6::text::jsonb->>'proposalDigest'", "o.proposal_digest=$6::text::jsonb->>'otherProposalDigest'"],
        ["different approved plan", "o.plan_digest=$6::text::jsonb->>'planDigest'", "o.plan_digest=$6::text::jsonb->>'otherPlanDigest'"],
        ["different selected approvals", "$6::text::jsonb->'approvalIds'", "$6::text::jsonb->'otherApprovalIds'"],
        ["nonhuman approval", "a.approver->>'kind'='user'", "a.approver->>'kind'='integration'"],
        ["unconsumed approval", "a.consumed_at is not null", "true"],
        ["expired approval", "a.expires_at > clock_timestamp()", "true"],
        ["discarded approval count", ">= ($6::text::jsonb->>'requiredApprovalCount')::integer", ">= 0"],
        ["ignored current rejection", "and not exists (select 1 from platform.approvals a where a.workspace_id=$1 and a.operation_id=$2 and a.approval_round=o.approval_round and a.decision='reject')", "and true"],
      ]) {
        expect(approvalGuard, `completion approval mutation must reach ${label}`).toContain(from);
        const replacement = query.replaceAll(from, to);
        expect(isFixedPlanProductInterpolation(changed(query, replacement), expression, replacement, composerSource), `completion approval: ${label}`).toBe(false);
      }
    }
    const risky: string[] = [];
    for (const fn of fns) {
      // a template literal handed to .query() that interpolates something other than the known constants
      for (const m of fn.body.matchAll(/\.query(?:<[^>]*>)?\(\s*`([\s\S]*?)`/g)) {
        for (const interp of m[1].matchAll(/\$\{([^}]*)\}/g)) {
          const expr = interp[1].trim();
          if (isFixedStartAuthorityInterpolation(fn, expr, m[1].slice(0, interp.index))) continue;
          if (isFixedPlanProductInterpolation(fn, expr, m[1], composerSource)) continue;
          // A failed native proof cannot fall through to the older name-based column/index recognizers.
          if (fn.file === "plan-artifacts.ts" && ["claim", "dispatch", "retainCleanupWriterHold", "reserveCleanupOwnerGrant", "insertCleanupOwnerGrant", "finishStandalone"].includes(fn.name)
            && /\b(?:planProductDispatchPredicate|productAuthority)\b/.test(expr)) {
            risky.push(`${key(fn)}: \${${expr}}`);
            continue;
          }
          // allowed: column lists, ordering fragments built from constants, parameter indexes ($${n})
          if (/^(?:[A-Z][A-Z0-9_]*|where\.join\(.*\)|params\.length|n|\w+Columns?|columns|set\.join\(.*\)|order\w*)$/.test(expr)) continue;
          if (/^\w*[Cc]olumns?\b/.test(expr) || /^\w+\.join\(/.test(expr) || /length/.test(expr)) continue;
          risky.push(`${key(fn)}: \${${expr}}`);
        }
      }
    }
    expect(risky, "interpolating anything but a constant column list into SQL text is an injection risk: use $n parameters").toEqual([]);
  });

  // Schema 61 (WP5 hold lifecycle): the janitor sweep and its scope helper write hold releases. Pinned by exact AST
  // text, so any edit (including a new predicate) must be re-reviewed and re-pinned. Their SQL takes no interpolation.
  it("pins the hold release writers (schema 61) by exact function text, with no interpolated SQL", () => {
    const text = readFileSync(path.join(REPOS, "plan-artifacts.ts"), "utf8");
    const sf = ts.createSourceFile("plan-artifacts.ts", text, ts.ScriptTarget.Latest, true);
    const pinned = new Map<string, string>();
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name && ["releaseDrainedHolds", "releaseDrainedScopeHold"].includes(node.name.text)) pinned.set(node.name.text, node.getText(sf));
      ts.forEachChild(node, visit);
    };
    visit(sf);
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    expect([...pinned.keys()].sort()).toEqual(["releaseDrainedHolds", "releaseDrainedScopeHold"]);
    expect(hash(pinned.get("releaseDrainedHolds")!)).toBe("0142d0a3f8358162064fbf45b3650723c73c96488bcb1b0f5faec523392cac4a");
    expect(hash(pinned.get("releaseDrainedScopeHold")!)).toBe("7aed855d22d6757440426853e0761ce198151c7aaddf3c80ead5cf81715abd76");
    for (const body of pinned.values()) expect(/\$\{/.test(body), "release SQL must not interpolate").toBe(false);
  });
});
