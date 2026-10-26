/**
 * The one composition of the mixed services' dependencies. The REST start (`runtime.ts`) and the worker
 * (`workflows/mixed-activities.ts`) both build their `MixedDeps` here, so the reference readiness that
 * `verifyParent` consults is the same check on both paths.
 */
import { createPlatformSemanticsStore } from "@/lib/controlplane/db/repos/executable-semantics";
import type { Sql } from "@/lib/controlplane/types";
import type { MixedDeps } from "./service";
import type { MixedWorld } from "./world";

export function composeMixedDeps(sql: Sql, world: MixedWorld): MixedDeps {
  return {
    sql,
    world,
    semantics: createPlatformSemanticsStore(sql),
    // A child with incoming references may start only when a typed-output source is wired. Receipts, the approved
    // contract and the parent digest are checked per consumer in materializeIncoming, never here.
    referencesReady: async () => typeof world.childTypedOutputs === "function",
  };
}
