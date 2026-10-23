/**
 * system.addResource / updateResource / removeResource. Split out of the
 * single-file module; the code is unchanged.
 */
import { z } from "zod";
import {
  id,
  Ownership,
  ResourceKind,
  ServiceSize,
  type Resource,
} from "@/lib/domain/types";
import { nodeName } from "@/lib/domain/graph";
import { inferCapability, slugify, uniqueName } from "@/lib/importers/types";
import {
  clone,
  requireResource,
  resolveNodeId,
} from "../_shared";
import { dropBindings, manifestAction, takenNames } from "./shared";
/* ------------------------------- resources -------------------------------- */

const AddResource = z.object({
  projectId: z.string().optional(),
  name: z.string().min(1),
  kind: ResourceKind,
  size: ServiceSize.optional(),
  ownership: Ownership.optional(),
  externalRef: z.string().optional(),
  config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  /** optionally connect it to a service in the same step */
  bindTo: z.string().optional(),
});
type AddResource = z.infer<typeof AddResource>;

manifestAction<AddResource>({
  id: "system.addResource",
  title: "Add resource",
  risk: "low",
  input: AddResource,
  build(project, input) {
    const next = clone(project.workingManifest);
    const ownership = input.ownership ?? "managed";
    if (ownership === "referenced" && !input.externalRef)
      throw new Error("A referenced resource needs the identifier it already has in your cloud. Pass externalRef (e.g. aws_db_instance.main), or leave ownership as 'managed' to let Zenith provision it.");

    const name = uniqueName(slugify(input.name, input.kind.replace("_", "-")), takenNames(next));
    const resource: Resource = {
      id: id(),
      name,
      kind: input.kind,
      config: input.config ?? {},
      size: input.size ?? "small",
      ownership,
      externalRef: input.externalRef,
    };
    next.resources.push(resource);

    const details: string[] = [];
    if (ownership !== "managed")
      details.push(`Marked "${ownership}": Zenith reads it and binds to it, but never provisions or deletes it — and it does not appear in the Zenith cost estimate.`);

    if (input.bindTo) {
      const fromId = resolveNodeId(next, input.bindTo);
      const capability = inferCapability(input.kind);
      next.bindings.push({
        id: id(),
        from: fromId,
        to: resource.id,
        capability,
        note: `${nodeName(next, fromId)} uses ${name} (${capability}).`,
      });
      details.push(`Connects ${nodeName(next, fromId)} to ${name}.`);
    }

    return { next, what: `Adds ${input.kind} "${name}"`, details, data: { resourceId: resource.id, name } };
  },
});

const UpdateResource = z.object({
  projectId: z.string().optional(),
  resourceId: z.string().min(1),
  name: z.string().optional(),
  size: ServiceSize.optional(),
  config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
type UpdateResource = z.infer<typeof UpdateResource>;

manifestAction<UpdateResource>({
  id: "system.updateResource",
  title: "Update resource",
  risk: "medium",
  input: UpdateResource,
  build(project, input) {
    const next = clone(project.workingManifest);
    const resource = requireResource(next, input.resourceId);
    const warnings: string[] = [];
    if (input.name && input.name !== resource.name) {
      const name = uniqueName(slugify(input.name, resource.name), takenNames(next).filter((n) => n !== resource.name));
      warnings.push(`Renaming ${resource.name} to ${name} changes the env vars injected into every service bound to it. Redeploy those services after this.`);
      resource.name = name;
    }
    if (input.size && input.size !== resource.size)
      warnings.push(`Resizing ${resource.name} restarts it. Expect a short interruption for anything using it.`);
    if (input.size) resource.size = input.size;
    if (input.config) resource.config = { ...resource.config, ...input.config };
    return { next, what: `Updates ${resource.kind} "${resource.name}"`, warnings, data: { resourceId: resource.id } };
  },
});

const RemoveResource = z.object({
  projectId: z.string().optional(),
  resourceId: z.string().min(1),
});
type RemoveResource = z.infer<typeof RemoveResource>;

manifestAction<RemoveResource>({
  id: "system.removeResource",
  title: "Remove resource",
  risk: "high",
  input: RemoveResource,
  build(project, input) {
    const next = clone(project.workingManifest);
    const resource = requireResource(next, input.resourceId);
    const dropped = dropBindings(next, resource.id);
    next.resources = next.resources.filter((r) => r.id !== resource.id);
    const stateful = resource.ownership === "managed" && resource.kind !== "email";
    return {
      next,
      what: `Removes ${resource.kind} "${resource.name}"`,
      details: dropped.length ? [`Also removes ${dropped.length} connection(s): ${dropped.join(", ")}.`] : [],
      warnings: stateful
        ? [`Deploying this destroys the data in ${resource.name}. Rollback restores the manifest, not the data — export anything you need first.`]
        : [],
      data: { resourceId: resource.id },
    };
  },
});
