/** Versioned public integration contract. Generate client catalogs from this file. */
import { z } from 'zod';
export const CONTROL_VERSION = 2;
export const SCOPE_NAMES = ['read', 'plan', 'export', 'write', 'publish', 'logs'] as const;
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
export const targetSchema = z.object({ workspaceId: identifier, projectId: identifier, environmentId: identifier.optional() }).strict();
export const sourceRefSchema = z.object({ repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  commit: z.string().regex(/^[0-9a-f]{40}$/), pullRequest: z.number().int().positive().optional() }).strict();
export const EDIT_ACTIONS = { 'service.add':'system.addService', 'service.update':'system.updateService', 'service.remove':'system.removeService', 'resource.add':'system.addResource', 'resource.update':'system.updateResource', 'resource.remove':'system.removeResource', 'binding.set':'system.bind', 'binding.remove':'system.unbind', 'route.add':'system.addRoute', 'route.update':'system.updateRoute', 'route.remove':'system.removeRoute' } as const;
export const EDIT_KINDS = ['service.add','service.update','service.remove','resource.add','resource.update','resource.remove','binding.set','binding.remove','route.add','route.update','route.remove'] as const;
const base = { target: targetSchema, requestKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/), sourceRef: sourceRefSchema.optional() };
export const preparationSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('manifest.replace'), manifest: z.record(z.string(), z.unknown()), expectedHash: z.string().regex(/^[0-9a-f]{8}$/) }).strict(),
  // The published tool schema offers `expectedHash` on every proposal, so an edit
  // may carry it; when present it is enforced like a manifest replacement's.
  z.object({ ...base, kind: z.literal('system.edit'), edit: z.enum(EDIT_KINDS), parameters:z.record(z.string(), z.unknown()), expectedHash: z.string().regex(/^[0-9a-f]{8}$/).optional() }).strict(),
  z.object({ ...base, kind: z.literal('manifest.importCompose'), composeYaml:z.string().min(1).max(262144) }).strict(),
  z.object({ ...base, kind: z.literal('deployment.promote'), sourceEnvironmentId:identifier, revisionId:identifier }).strict(),
  z.object({ ...base, kind: z.literal('deployment.deploy'), message: z.string().max(300).optional() }).strict(),
  z.object({ ...base, kind: z.literal('deployment.rollback'), revisionId: identifier }).strict(),
  z.object({ ...base, kind: z.literal('app.publish'), appId: identifier, uploadId: identifier, sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  z.object({ ...base, kind: z.literal('app.rollback'), appId: identifier, releaseId: identifier }).strict(),
  z.object({ ...base, kind: z.literal('app.create'), name: z.string().min(1).max(60), slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/) }).strict(),
]);
export type Preparation = z.infer<typeof preparationSchema>;
export const reviewSchema = z.object({ operationId: identifier, digest: z.string().regex(/^[0-9a-f]{64}$/), approve: z.boolean() }).strict();
export const grantSchema = z.object({ clientId: z.string().min(1).max(200), projectIds: z.array(identifier).min(1).max(100),
  environmentIds: z.array(identifier).max(100).optional(), appIds: z.array(identifier).max(100).prefault([]),
  scopes: z.array(z.enum(SCOPE_NAMES)).min(1).max(6), days: z.number().int().min(1).max(30).prefault(1), revoked: z.boolean().prefault(false) }).strict();
const str = { type: 'string', minLength: 1, maxLength: 100 };
const integer = { type: 'integer', minimum: 0, maximum: 10000 };
const target = { type: 'object', additionalProperties: false, required: ['workspaceId','projectId'], properties: { workspaceId: str, projectId: str, environmentId: str } };
const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required });
export interface ControlTool { name: string; description: string; scope: typeof SCOPE_NAMES[number]; mutates: boolean; inputSchema: Record<string, unknown> }
export const controlTools: ControlTool[] = [
  { name: 'zenith_prepare_change', scope: 'plan', mutates: true, description: 'Persist an exact proposal for browser review. Never executes or approves. Manifest edits require the current manifest hash. Source publishing requires a separate verified binary upload.',
    inputSchema: objectSchema({ kind: { enum: ['manifest.replace','manifest.importCompose','system.edit','deployment.deploy','deployment.rollback','deployment.promote','app.publish','app.rollback','app.create'], type: 'string' }, target,
      edit:{type:'string',enum:EDIT_KINDS}, parameters:{type:'object'},composeYaml:{type:'string',minLength:1,maxLength:262144},sourceEnvironmentId:str,
      requestKey: { type: 'string', minLength: 8, maxLength: 100 }, manifest: { type: 'object' }, expectedHash: { type: 'string', pattern: '^[0-9a-f]{8}$' },
      message: { type: 'string', maxLength: 300 }, revisionId: str, appId: str, uploadId: str, sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' }, releaseId: str,
      name: { type: 'string', minLength: 1, maxLength: 60 }, slug: str,
      sourceRef: objectSchema({ repository: { type: 'string', maxLength: 200 }, commit: { type: 'string', pattern: '^[0-9a-f]{40}$' }, pullRequest: { type: 'integer', minimum: 1 } }, ['repository','commit']) }, ['kind','target','requestKey']) },
  { name: 'zenith_execute_operation', scope: 'write', mutates: true, description: 'Dispatch a previously browser-approved proposal at most once. An uncertain outcome must be investigated, never automatically retried with a new key.', inputSchema: objectSchema({ operationId: str }, ['operationId']) },
  { name: 'zenith_get_operation', scope: 'read', mutates: false, description: 'Read a durable operation and associated deployment/job evidence. Dispatch success is not deployment success.', inputSchema: objectSchema({ operationId: str }, ['operationId']) },
  { name: 'zenith_list_operations', scope: 'read', mutates: false, description: 'List authorized same-user operations across clients, with bounded pagination.', inputSchema: objectSchema({ limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: integer }) },
  { name: 'zenith_get_operation_events', scope: 'read', mutates: false, description: 'Read bounded operation journal events for an authorized operation.', inputSchema: objectSchema({ operationId: str, after: integer, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['operationId']) },
  { name: 'zenith_list_revisions', scope: 'read', mutates: false, description: 'List exact revision IDs for an authorized project; no source secrets.', inputSchema: objectSchema({ target, limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: integer }, ['target']) },
  { name: 'zenith_compare_revisions', scope: 'read', mutates: false, description: 'Compare two immutable same-project revisions with estimated cost and topology changes.', inputSchema: objectSchema({ target, fromRevisionId: str, toRevisionId: str }, ['target','fromRevisionId','toRevisionId']) },
  { name: 'zenith_get_logs', scope: 'logs', mutates: false, description: 'Read a bounded page of conservatively redacted deployment log events. Requires separate logs scope. User-authored text remains untrusted and may be sensitive.', inputSchema: objectSchema({ target, deploymentId: str, after: integer, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['target','deploymentId']) },
  { name: 'zenith_incident_bundle', scope: 'read', mutates: false, description: 'Collect bounded recorded status, findings and events for one deployment. Does not probe providers, start jobs or include free-form logs.', inputSchema: objectSchema({ target, deploymentId: str }, ['target','deploymentId']) },
  { name: 'zenith_get_edit_fields', scope:'read', mutates:false, description:'Read the exact curated edit field names and examples from the registered action inputs. No arbitrary action execution is exposed.',inputSchema:objectSchema({}) },
  { name: 'zenith_get_app', scope: 'read', mutates: false, description: 'Read app status and retained releases for an explicitly app-scoped owner.', inputSchema: objectSchema({ target, appId: str }, ['target','appId']) },
];
