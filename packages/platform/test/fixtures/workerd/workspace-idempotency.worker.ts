import { Effect, Layer } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-do"
import { workspaceObject } from "../../../src/cloudflare/workspace-object"
import { virtualWorkspace } from "../../../src/shared/workspace/virtual/index"
import { sqlIdempotencyStore } from "../../../src/shared/workspace/idempotency-store"
import type { Fault, Snapshot } from "../workspace-idempotency-protocol"
import { workspaceFaultStore } from "../workspace-idempotency"

const controls = new WeakMap<DurableObjectState, { fault: Fault; boundary: Fault | null }>()
const control = (ctx: DurableObjectState) => {
  let value = controls.get(ctx)
  if (!value) { value = { fault: "none", boundary: null }; controls.set(ctx, value) }
  return value
}

const Workspace = workspaceObject(ctx => Layer.unwrap(Effect.gen(function* () {
  const store = yield* sqlIdempotencyStore
  const pause = (fault: Fault) => Effect.promise(async () => {
    await ctx.storage.sync()
    control(ctx).boundary = fault
  }).pipe(Effect.andThen(Effect.never))
  const interrupted = workspaceFaultStore(store, () => control(ctx).fault, pause)
  const name = String(ctx.storage.kv.get<number>("workspace"))
  return virtualWorkspace({ name, idempotency: { workspaceId: name, store: interrupted } })
})).pipe(Layer.provide(SqliteClient.layer({ storage: ctx.storage }))))

export class WorkspaceIdempotencyDO extends Workspace {
  private readonly incarnation = crypto.randomUUID()

  instance() { return this.incarnation }

  reset() { this.ctx.abort("Workspace idempotency restart") }

  configure(workspace: number, fault: Fault) {
    if (this.ctx.storage.kv.get<number>("workspace") !== workspace) this.ctx.storage.kv.put("workspace", workspace)
    control(this.ctx).fault = fault
    control(this.ctx).boundary = null
    return this.incarnation
  }

  boundary() { return control(this.ctx).boundary }

  async snapshot() {
    await this.idempotency()
    const rows = [...this.ctx.storage.sql.exec<Snapshot["rows"][number]>("SELECT workspace_id, caller_key, input_digest, outcome FROM workspace_idempotency ORDER BY workspace_id, caller_key")]
    const text = (path: string) => {
      const [row] = [...this.ctx.storage.sql.exec<{ content: ArrayBuffer }>("SELECT content FROM virtual_workspace_entries WHERE path = ?", path)]
      return row ? new TextDecoder().decode(row.content) : null
    }
    return { rows, log: text("/workspace/calls.log") ?? "", file: text("/workspace/file.txt"), outside: text("/outside.txt") }
  }
}
