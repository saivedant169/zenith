/**
 * In-memory product-store port for the activity tests that do not need the real
 * store. The REAL port (`createProductPort`, over the file store) is tested in
 * product-port.test.ts and used by journey.test.ts; this fake records exactly
 * what the activities asked it to write.
 */
import type { DeploymentStatus, Output, StepStatus } from "@/lib/domain/types";
import type { DeploymentOutcome, ProductContext, ProductPort, ProductRevision } from "@/lib/execution/ports";
import { ProductNotFoundError } from "@/lib/execution/product-port";
import type { StepName } from "@/lib/workflows/types";
import { ENV, PRODUCT_CONNECTION, PROJECT, REVISION, WS, webDbManifest } from "./fixtures";

export class FakeProduct implements ProductPort {
  revisions = new Map<string, ProductRevision>([[REVISION, { id: REVISION, number: 1, manifest: webDbManifest() }]]);
  base: Omit<ProductContext, "revision" | "deploymentId"> = {
    workspace: { id: WS, name: "Atlas", slug: "atlas" },
    project: { id: PROJECT, name: "Atlas", slug: "atlas" },
    environment: {
      id: ENV,
      name: "production",
      class: "production",
      provider: "aws",
      region: "us-east-1",
      baseDomain: "atlas.zenith.test",
      connectionId: PRODUCT_CONNECTION,
      policies: { approvalRequired: false, allowStatefulDeletion: false },
    },
  };
  readonly steps: { deploymentId: string; step: StepName; status: StepStatus; detail?: string; deploymentStatus?: DeploymentStatus }[] = [];
  readonly statuses: DeploymentStatus[] = [];
  readonly outcomes: { deploymentId: string; outcome: DeploymentOutcome; error?: string }[] = [];
  readonly outputs: Output[] = [];
  failRecordStep = false;

  setManifest(manifest: unknown, id = REVISION): void {
    this.revisions.set(id, { id, number: 1, manifest });
  }

  async loadContext({ workspaceId, environmentId, revisionId, deploymentId }: { workspaceId: string; environmentId: string; revisionId?: string; deploymentId?: string }): Promise<ProductContext> {
    if (workspaceId !== this.base.workspace.id || environmentId !== this.base.environment.id) throw new ProductNotFoundError("environment_not_found", "The environment was not found in this workspace.");
    const wanted = revisionId ?? this.base.environment.deployedRevisionId;
    let revision: ProductRevision | undefined;
    if (wanted) {
      revision = this.revisions.get(wanted);
      if (!revision) throw new ProductNotFoundError("revision_not_found", "The revision was not found in this project.");
    }
    return { ...structuredClone(this.base), ...(revision ? { revision } : {}), ...(deploymentId ? { deploymentId } : {}) };
  }

  async loadRevision({ revisionId }: { workspaceId: string; environmentId: string; revisionId: string }): Promise<ProductRevision | null> {
    return this.revisions.get(revisionId) ?? null;
  }

  async resolveEnvironment(environmentId: string): Promise<{ workspaceId: string; projectId: string } | null> {
    return environmentId === this.base.environment.id ? { workspaceId: this.base.workspace.id, projectId: PROJECT } : null;
  }

  async recordStep(input: { workspaceId: string; environmentId: string; deploymentId: string; step: StepName; status: StepStatus; detail?: string; at: string; deploymentStatus?: DeploymentStatus }): Promise<void> {
    if (this.failRecordStep) throw new Error("product store unavailable");
    this.steps.push({ deploymentId: input.deploymentId, step: input.step, status: input.status, ...(input.detail ? { detail: input.detail } : {}), ...(input.deploymentStatus ? { deploymentStatus: input.deploymentStatus } : {}) });
  }

  async setDeploymentStatus(input: { deploymentId: string; status: DeploymentStatus }): Promise<void> {
    this.statuses.push(input.status);
  }

  async recordOutputs(input: { deploymentId: string; outputs: Output[] }): Promise<void> {
    this.outputs.push(...input.outputs);
  }

  async commitOutcome(input: { deploymentId: string; outcome: DeploymentOutcome; error?: string }): Promise<void> {
    this.outcomes.push({ deploymentId: input.deploymentId, outcome: input.outcome, ...(input.error ? { error: input.error } : {}) });
  }
}
