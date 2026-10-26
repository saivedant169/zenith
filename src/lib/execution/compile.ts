/**
 * Graph → pinned OpenTofu workspace.
 *
 *   graph nodes ──driver.compile──▶ TofuFragment per node ──assembleWorkspace──▶ TofuWorkspace
 *
 * Which nodes compile: `managed` nodes always (their driver must exist and be
 * able to compile); `referenced` nodes when their driver offers a compile (it
 * may only read: the assembler rejects a `resource` block on a node Zenith does
 * not manage); `external` nodes never.
 *
 * `CompileContext.ref(address, attribute)` is implemented here, because drivers
 * are told never to hard-code another node's tofu label. Compilation records
 * references as inert interpolation tokens; a second pass resolves them once
 * all fragments exist. A declared `refLocalName(address, attribute)` local wins;
 * otherwise a plain attribute path resolves on the primary address.
 * Unpublished semantic keys (e.g. `target_group_arn:service/web`) are refused.
 * It returns the INTERPOLATION form, ready to use as a value or to embed in a
 * longer string:
 *
 *     published local → "${local.ref_network_main__id}"
 *     plain fallback  → "${oci_core_vcn.network_main.id}"
 *
 * The node's tofu address is its PRIMARY address: the entry of the fragment's
 * `addresses` whose label equals the sanitized node address (`network/main` →
 * `network_main`, per DRIVER-CONVENTIONS), else the first resource address the
 * fragment lists. Reciprocal references between nodes do not require a compile
 * order: OpenTofu evaluates dependencies between the individual resources.
 * A driver may reference any node, not only those it declared in `dependsOn`.
 *
 * State backend: `backendForConnection` (src/lib/tofu/backends.ts) per provider; for AWS the S3 bucket and optional KMS key of the
 * connection, key `zenith/<workspace>/<environment>/terraform.tfstate`. The
 * connection holds only non-secret identifiers; credentials never enter a
 * workspace file (the assembler refuses credential-shaped keys).
 */
import type { CompileContext, TofuFragment } from "@/lib/drivers/types";
import type { ProviderConnection } from "@/lib/credentials/types";
import { awsBootstrapContextForConnection } from "@/lib/credentials/aws/naming";
import { AwsLimitError, assertAwsBootstrapLimits } from "@/lib/credentials/aws/limits";
import type { ProviderKey, ResourceGraph } from "@/lib/resources/types";
import { refLocalName } from "@/lib/providers/aws/drivers/shared/refs";
import { assembleWorkspace, TofuWorkspaceError, type BackendConfig } from "@/lib/tofu/workspace";
import type { ProviderSetName, ProviderSetSpec } from "@/lib/tofu/providers";
import type { TofuWorkspace } from "@/lib/tofu/types";
import { backendForConnection } from "@/lib/tofu/backends";
import { assertBackendAdmissible } from "@/lib/tofu/backend-capabilities";
import { scanHclTemplate } from "@/lib/tofu/hcl-template";
import type { ExecContext } from "./context";
import { inputVariable, type ConsumedInput } from "./typed-inputs";
import { placeholdersIn, rewriteSpecMarkers, substituteInputTokens } from "./typed-substitution";
import { StepFailedError } from "./errors";
import type { DriverLookup, WorkspaceOverrides } from "./ports";
import { baseTags, namePrefix, nodeTags } from "./session";
import { errorText, safeText } from "./text";

// Semantic keys include AWS's colon-separated target addresses and ports.
// These are lookup keys only, never inserted into an HCL expression. Reuse the
// publisher's canonical helper unchanged; no provider driver is rewritten.
const REFERENCE_KEY = /^[A-Za-z_][A-Za-z0-9_./:[\]-]*(?![\s\S])/;
// Identifier segments with optional numeric indexes; no calls, splats, quoted
// keys or template syntax. The end assertions also reject a final newline.
const ATTRIBUTE = /^[A-Za-z_][A-Za-z0-9_-]*(?:\[\d+\])*(?:\.[A-Za-z_][A-Za-z0-9_-]*(?:\[\d+\])*)*(?![\s\S])/;
const TOFU_ADDRESS = /^(?:data\.)?[A-Za-z_][A-Za-z0-9_-]*\.[A-Za-z_][A-Za-z0-9_-]*(?![\s\S])/;

/** `service/web` → `service_web`, per DRIVER-CONVENTIONS ("labels derived from the node address"). */
export const sanitizeLabel = (address: string): string => address.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** The node's primary tofu address in a fragment (see the module comment). */
export function primaryAddress(nodeAddress: string, fragment: TofuFragment): string | undefined {
  const wanted = sanitizeLabel(nodeAddress);
  const resources = fragment.addresses.filter((a) => !a.startsWith("data."));
  const matching = (list: string[]): string | undefined => list.find((a) => a.slice(a.lastIndexOf(".") + 1) === wanted);
  return matching(resources) ?? resources[0] ?? matching(fragment.addresses) ?? fragment.addresses[0];
}

export interface CompiledGraph {
  fragments: Map<string, TofuFragment>;
  /** Typed inputs the compiled output actually uses (a driver's `ctx.input` or a substituted manifest marker). */
  usedInputs: ReadonlySet<string>;
}

interface PendingReference { source: string; target: string; attribute: string }

const REFERENCE_TOKEN = /^__zenith_ref_/;

function refuseReference({ source, target, attribute }: PendingReference): never {
  throw new StepFailedError(`${safeText(source, 120)} references ${safeText(target, 120)} with an invalid or unpublished attribute reference "${safeText(attribute, 60)}".`);
}

/**
 * Replace generated identifiers only where HCL evaluates them. Drivers may
 * strip `${...}` to embed a reference inside a larger expression. The shared
 * grammar scanner distinguishes those roots from escaped/literal template
 * text, including nested quoted/heredoc strings and comments. Probing one
 * occurrence at a time preserves a literal copy even when the same string
 * also contains a live reference. No manifest text becomes an expression.
 */
function substituteReferences(value: unknown, source: string, resolved: ReadonlyMap<string, string>): unknown {
  const refuse = (): never => { throw new StepFailedError(`${safeText(source, 120)} contains an unresolved or malformed OpenTofu reference token.`); };
  if (typeof value === "string") {
    if (!value.includes("__zenith_ref_")) return value;
    try {
      const roots = scanHclTemplate(value).roots;
      for (const root of roots) if (REFERENCE_TOKEN.test(root) && !resolved.has(root)) return refuse();
      const replaced = value.replace(/\b__zenith_ref_[0-9]+__\b/g, (token: string, offset: number) => {
        if (!roots.has(token)) return token; // literal data, never a reference
        let probe = `__zenith_probe_${offset}__`;
        while (value.includes(probe)) probe += "_";
        const probed = value.slice(0, offset) + probe + value.slice(offset + token.length);
        return scanHclTemplate(probed).roots.has(probe) ? resolved.get(token) ?? refuse() : token;
      });
      if ([...scanHclTemplate(replaced).roots].some((root) => REFERENCE_TOKEN.test(root))) return refuse();
      return replaced;
    } catch (error) {
      if (error instanceof StepFailedError) throw error;
      return refuse(); // scanner diagnostics never reflect external string values
    }
  }
  if (Array.isArray(value)) return value.map((item) => substituteReferences(item, source, resolved));
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).map(([key, item]) => [substituteReferences(key, source, resolved) as string, substituteReferences(item, source, resolved)] as const);
    if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new StepFailedError(`${safeText(source, 120)} contains duplicate keys after OpenTofu reference resolution.`);
    return Object.fromEntries(entries);
  }
  return value;
}

export function compileGraph(input: { graph: ResourceGraph; environmentId: string; region: string; tags: Record<string, string>; drivers: DriverLookup; connection?: ProviderConnection; inputs?: readonly ConsumedInput[] }): CompiledGraph {
  const { graph, drivers } = input;
  // Manifest markers `{{zenith.input.<name>}}` in non-secret fields become placeholders the drivers copy like any string; they become the
  // typed-input variable expression after compilation. Every marker is validated here (undeclared, secret in a non-secret field, ...).
  const consumed = new Map((input.inputs ?? []).map((item) => [item.name, item]));
  const names = [...consumed.keys()].sort();
  const indexOf = new Map(names.map((name, index) => [name, index]));
  const prepared = new Map(graph.nodes.map((n) => [n.address, rewriteSpecMarkers(n, consumed, indexOf)]));
  const nodes = new Map([...prepared].map(([address, rewrite]) => [address, rewrite.node]));
  const usedNames = new Set<string>();
  const pending = new Map<string, PendingReference>();
  const fragments = new Map<string, TofuFragment>();
  const prefix = namePrefix(input.environmentId);
  const hasAwsNodes = graph.nodes.some((node) => node.provider === "aws" && node.ownership !== "external");
  const awsBootstrap = input.connection && hasAwsNodes
    ? awsBootstrapContextForConnection(input.connection.config, input.region) : undefined;
  if (input.connection && hasAwsNodes && input.connection.status !== "verified") throw new StepFailedError("AWS compilation requires a verified connection.");
  if (awsBootstrap) {
    // Explicit refusal before any driver runs: the saved suffix and environment must fit every IAM/S3 name derived from them.
    try { assertAwsBootstrapLimits({ environmentId: input.environmentId, bootstrapNameSuffix: awsBootstrap.bootstrapNameSuffix, accountId: awsBootstrap.accountId, region: input.region }); }
    catch (error) { if (error instanceof AwsLimitError) throw new StepFailedError(error.message); throw error; }
  }

  const compileNode = (address: string): TofuFragment | null => {
    const node = nodes.get(address);
    if (!node) throw new StepFailedError(`A driver referenced ${safeText(address, 120)}, which is not a node of this graph.`);
    if (node.ownership === "external") {
      return null;
    }
    const driver = drivers(node.provider, node.nativeType);
    if (!driver || typeof driver.compile !== "function") {
      if (node.ownership === "managed") {
        throw new StepFailedError(`${node.address}: ${driver ? `driver ${driver.id} cannot compile` : `no driver is registered for ${node.provider} ${node.nativeType}`}.`);
      }
      return null; // a referenced node nobody can read contributes nothing
    }
    const ctx: CompileContext = {
      environmentId: input.environmentId,
      namePrefix: prefix,
      region: node.region || input.region,
      tags: nodeTags(input.tags, node),
      ...(node.provider === "azure" && input.connection?.config.provider === "azure" && input.connection.config.cloud ? { azureCloud: input.connection.config.cloud } : {}),
      ...(node.provider === "aws" && awsBootstrap ? { awsBootstrap: awsBootstrapContextForConnection(input.connection!.config, node.region || input.region) } : {}),
      ...(process.env.ZENITH_AWS_ALLOW_EXPERIMENTAL === "1" ? { allowExperimentalAws: true } : {}),
      node: (a) => nodes.get(a),
      nodes: () => [...nodes.values()],
      input: (name) => {
        // A typed dependency input of this consumer: only a declared one resolves, as the interpolation of its variable.
        if (!input.inputs?.some((declared) => declared.name === name)) throw new StepFailedError(`${safeText(node.address, 120)} asked for the typed input "${safeText(name, 60)}", which this operation does not consume.`);
        usedNames.add(name);
        return "${var." + inputVariable(name) + "}";
      },
      ref: (target, attribute) => {
        const reference = { source: node.address, target, attribute };
        if (!nodes.has(target) || typeof attribute !== "string" || attribute.length > 512 || !REFERENCE_KEY.test(attribute)) return refuseReference(reference);
        const token = `__zenith_ref_${pending.size}__`;
        pending.set(token, reference);
        return `\${${token}}`;
      },
    };
    let fragment: TofuFragment;
    try {
      fragment = driver.compile(node, ctx);
    } catch (err) {
      if (err instanceof StepFailedError) throw err;
      throw new StepFailedError(`Driver ${driver.id} failed to compile ${node.address}: ${errorText(err)}`);
    }
    return fragment;
  };

  // Phase 1 is flat: ctx.ref records a reference, never invokes a driver.
  for (const node of graph.nodes) {
    const fragment = compileNode(node.address);
    if (fragment) fragments.set(node.address, fragment);
  }

  // Phase 2 resolves every request, even one the driver ultimately discarded.
  const resolved = new Map<string, string>();
  for (const [token, reference] of pending) {
    const { source, target, attribute } = reference;
    const fragment = fragments.get(target);
    if (!fragment) throw new StepFailedError(`${safeText(source, 120)} references ${safeText(target, 120)} with attribute "${safeText(attribute, 60)}", which has no OpenTofu address (it is external, or its driver cannot compile).`);
    const local = refLocalName(target, attribute);
    if (fragment.locals && Object.hasOwn(fragment.locals, local)) {
      resolved.set(token, `local.${local}`);
      continue;
    }
    if (!ATTRIBUTE.test(attribute)) return refuseReference(reference);
    const primary = primaryAddress(target, fragment);
    if (!primary) throw new StepFailedError(`${safeText(source, 120)} references ${safeText(target, 120)} with attribute "${safeText(attribute, 60)}", which has no OpenTofu address.`);
    if (!TOFU_ADDRESS.test(primary)) return refuseReference(reference);
    resolved.set(token, `${primary}.${attribute}`);
  }
  for (const [address, fragment] of fragments) fragments.set(address, substituteReferences(fragment, address, resolved) as TofuFragment);
  // Typed inputs: a marker the node's own spec used must have reached its compiled output (else its field cannot take the value),
  // then every placeholder becomes the variable expression.
  const seen = new Set<number>();
  for (const [address, rewrite] of prepared) {
    if (!rewrite.used.size) continue;
    const present = fragments.has(address) ? placeholdersIn(fragments.get(address)) : new Set<number>();
    for (const index of rewrite.used) if (!present.has(index)) throw new StepFailedError(`${safeText(address, 120)}: the typed input "${safeText(names[index] ?? "?", 60)}" was not carried into this resource's configuration; its field cannot accept the reference.`);
  }
  for (const [address, fragment] of fragments) fragments.set(address, substituteInputTokens(fragment, address, names, seen) as TofuFragment);
  for (const index of seen) usedNames.add(names[index]);
  return { fragments, usedInputs: usedNames };
}

/* ------------------------------ workspace -------------------------------- */

const DEFAULT_PROVIDER_SETS: Partial<Record<ProviderKey, ProviderSetName>> = {
  aws: "aws",
  gcp: "gcp",
  azure: "azure",
  oci: "oci",
  kubernetes: "kubernetes",
  zenith: "kubernetes",
};

function providerSetFor(provider: ProviderKey, overrides?: WorkspaceOverrides): ProviderSetName | ProviderSetSpec {
  const chosen = overrides?.providerSet?.(provider) ?? DEFAULT_PROVIDER_SETS[provider];
  if (!chosen) throw new StepFailedError(`Environments on ${provider} are not executed through OpenTofu by this worker.`);
  return chosen;
}

function backendFor(ec: ExecContext, connection: ProviderConnection, overrides?: WorkspaceOverrides): { backend: BackendConfig; stateKey?: string } {
  if (overrides?.backend) return overrides.backend({ connection, workspaceId: ec.workspaceId, environmentId: ec.environmentId });
  try {
    // aws: S3 (key unchanged: zenith/<ws>/<env>/terraform.tfstate); gcp: GCS; azure: azurerm (Entra);
    // oci: S3-compatible Object Storage. Kubernetes needs an explicit override.
    const chosen = backendForConnection(connection, { workspaceId: ec.workspaceId, environmentId: ec.environmentId });
    // PROD-DUR-06: refuse a backend that definitely cannot lock or encrypt state. Unverified properties stay visible to restore, not hidden.
    assertBackendAdmissible(chosen.backend);
    return chosen;
  } catch (err) {
    if (err instanceof TofuWorkspaceError) throw new StepFailedError(`State backend refused: ${safeText(err.message, 400)}`);
    throw err;
  }
}

export function buildWorkspace(input: {
  ec: ExecContext;
  graph: ResourceGraph;
  connection: ProviderConnection;
  drivers: DriverLookup;
  overrides?: WorkspaceOverrides;
}): { ws: TofuWorkspace; fragments: Map<string, TofuFragment> } {
  const { ec, graph, connection } = input;
  const env = ec.product.environment;
  const tags = baseTags(ec);
  if (env.provider === "aws" && connection.config.provider !== "aws") throw new StepFailedError("AWS compilation requires an AWS connection.");
  if (env.provider === "aws") {
    if (connection.status !== "verified") throw new StepFailedError("AWS compilation requires a verified connection.");
    awsBootstrapContextForConnection(connection.config, env.region);
  }
  const typed = ec.typedInputs ?? [];
  const { fragments, usedInputs } = compileGraph({ graph, environmentId: ec.environmentId, region: env.region, tags, drivers: input.drivers, connection, ...(typed.length ? { inputs: typed } : {}) });
  // Non-secret inputs are always declared (their value is part of the configuration digest). A secret input is declared as a sensitive
  // variable only when the compiled output uses it; a secret used through a `secretRef` is delivered by the provider's secret path instead.
  const declared = typed.filter((item) => item.secret === undefined || usedInputs.has(item.name));
  const { backend, stateKey } = backendFor(ec, connection, input.overrides);
  const providerSet = providerSetFor(env.provider, input.overrides);
  try {
    const ws = assembleWorkspace({
      graph, fragments, providerSet, region: env.region, backend, stateKey, tags,
      ...(declared.length ? { inputs: declared.map((item) => ({ name: item.name, type: item.type === "number" ? "number" as const : item.type === "boolean" ? "boolean" as const : "string" as const, sensitive: item.secret !== undefined, ...(item.secret === undefined ? { value: item.value } : {}) })) } : {}),
    });
    return { ws, fragments };
  } catch (err) {
    // Assembler refusals (duplicate addresses, forbidden constructs, credential-shaped keys) name node addresses, never values.
    if (err instanceof TofuWorkspaceError) throw new StepFailedError(`The infrastructure configuration was refused: ${safeText(err.message, 400)}`);
    throw err;
  }
}
