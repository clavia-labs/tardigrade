import { Effect, Layer } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-do"
import { ObjectStorage, type ObjectRef } from "@clavia/tardigrade-store"
import { objectStorageFromR2 } from "@clavia/tardigrade-cloudflare/object-storage/r2"
import { workspaceObject } from "../../../src/cloudflare/workspace-object"
import { virtualWorkspace } from "../../../src/shared/workspace/virtual/index"
import { sqlIdempotencyStore } from "../../../src/shared/workspace/idempotency-store"
import { workspaceFaultStore } from "./idempotency"
import type { Fault } from "./protocol"
import type { WorkspaceCrashPoint } from "./shared"

interface LifecycleEnv { readonly WORKSPACE_LIFECYCLE_OBJECTS: R2Bucket }
const controls = new WeakMap<DurableObjectState, { fault: Fault; boundary: boolean }>()
const control = (ctx: DurableObjectState) => {
  let value = controls.get(ctx)
  if (!value) { value = { fault: "none", boundary: false }; controls.set(ctx, value) }
  return value
}
const objects = (ctx: DurableObjectState, env: LifecycleEnv) => objectStorageFromR2(env.WORKSPACE_LIFECYCLE_OBJECTS, { prefix: `lifecycle/${ctx.id}/` })
const Workspace = workspaceObject<LifecycleEnv>((ctx, env) => Layer.unwrap(Effect.gen(function* () {
  const store = yield* sqlIdempotencyStore
  const contentStore = yield* ObjectStorage
  const pause = () => Effect.promise(async () => { await ctx.storage.sync(); control(ctx).boundary = true }).pipe(Effect.andThen(Effect.never))
  return virtualWorkspace({ name: ctx.id.toString(), storageChunkBytes: 7, contentStore, idempotency: {
    workspaceId: ctx.id.toString(), store: workspaceFaultStore(store, () => control(ctx).fault, pause),
  } })
})).pipe(Layer.provide(SqliteClient.layer({ storage: ctx.storage })), Layer.provide(objects(ctx, env))))

export class WorkspaceLifecycleDO extends Workspace {
  private readonly incarnation = crypto.randomUUID()
  instance() { return this.incarnation }
  armFault(fault: WorkspaceCrashPoint) { control(this.ctx).fault = fault; control(this.ctx).boundary = false }
  boundary() { return control(this.ctx).boundary }
  reset() { this.ctx.abort("Workspace lifecycle restart") }
  resolve(object: ObjectRef) {
    return Effect.runPromise(Effect.flatMap(ObjectStorage, store => store.get(object)).pipe(Effect.provide(objects(this.ctx, this.env))))
  }
}
