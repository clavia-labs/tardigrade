import { join } from "node:path"
import { createInterface } from "node:readline"
import { Effect, Layer, ManagedRuntime } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { FilesystemWorkspace, type FilesystemWorkspaceError, type WorkspaceIdempotencyStore } from "@clavia/tardigrade-libraries/filesystem/index"
import { ObjectStorage, sqlObjectStorage } from "@clavia/tardigrade-store"
import { sqlIdempotencyStore } from "../../../src/shared/workspace/idempotency-store"
import { workspaceFaultStore } from "./idempotency"
import type { Fault } from "./protocol"
import { lifecycleRequest, type WorkspaceScenarioRequest, type LifecycleResponse } from "./shared"

// serveWorkspaceLifecycle answers scenario requests from stdin with the workspace a process builds over the SQLite state in directory; bunWorkspaceLifecycle kills and restarts the process.
export async function serveWorkspaceLifecycle(directory: string, workspace: (contentStore: typeof ObjectStorage.Service, idempotency: WorkspaceIdempotencyStore) => Layer.Layer<FilesystemWorkspace, FilesystemWorkspaceError>): Promise<void> {
  const send = (message: LifecycleResponse) => process.stdout.write(`${JSON.stringify(message)}\n`)
  let fault: Fault = "none"
  const runtime = ManagedRuntime.make(Layer.unwrap(Effect.gen(function* () {
    const objects = yield* sqlObjectStorage({ chunkBytes: 7 })
    const store = yield* sqlIdempotencyStore
    const faultStore = workspaceFaultStore(store, () => fault, () => Effect.sync(() => { send({ type: "boundary" }) }).pipe(Effect.andThen(Effect.never)))
    return Layer.merge(workspace(objects, faultStore), Layer.succeed(ObjectStorage, objects))
  })).pipe(Layer.provide(SqliteClient.layer({ filename: join(directory, "state.sqlite") }))))
  const handle = async (request: WorkspaceScenarioRequest): Promise<LifecycleResponse> => {
    fault = request.type === "bash" ? request.fault ?? (request.loseReply ? "afterComplete" : "none") : "none"
    try {
      const value = await runtime.runPromise(Effect.gen(function* () { return yield* lifecycleRequest(yield* FilesystemWorkspace, yield* ObjectStorage, request) }))
      return { type: "result", value: value ?? null }
    } catch (error) { return { type: "error", message: String(error) } }
  }
  try {
    await runtime.context()
    send({ type: "ready" })
    let replies = Promise.resolve()
    for await (const line of createInterface({ input: process.stdin })) {
      const reply = handle(JSON.parse(line) as WorkspaceScenarioRequest)
      replies = replies.then(async () => { send(await reply) })
    }
    await replies
  } finally { await runtime.dispose() }
}
