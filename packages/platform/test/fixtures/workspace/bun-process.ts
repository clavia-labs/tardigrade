import { join } from "node:path"
import { createInterface } from "node:readline"
import { Effect, Layer, ManagedRuntime } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { FilesystemWorkspace } from "@clavia/tardigrade-libraries/filesystem/index"
import { ObjectStorage, sqlObjectStorage } from "@clavia/tardigrade-store"
import { localWorkspace } from "../../../src/bun/workspace"
import { sqlIdempotencyStore } from "../../../src/shared/workspace/idempotency-store"
import { workspaceFaultStore } from "../workspace-idempotency"
import { lifecycleRequest, type LifecycleRequest, type LifecycleResponse } from "./shared"

const directory = process.argv[2]!
const send = (message: LifecycleResponse) => process.stdout.write(`${JSON.stringify(message)}\n`)
let loseReply = false
const runtime = ManagedRuntime.make(Layer.unwrap(Effect.gen(function* () {
  const objects = yield* sqlObjectStorage({ chunkBytes: 7 })
  const store = yield* sqlIdempotencyStore
  const faultStore = workspaceFaultStore(store, () => loseReply ? "afterComplete" : "none", () => Effect.sync(() => { send({ type: "boundary" }) }).pipe(Effect.andThen(Effect.never)))
  return Layer.merge(localWorkspace({ directory: join(directory, "files"), contentStore: objects, idempotency: { workspaceId: "lifecycle", store: faultStore } }), Layer.succeed(ObjectStorage, objects))
})).pipe(Layer.provide(SqliteClient.layer({ filename: join(directory, "state.sqlite") }))))

try {
  await runtime.context()
  send({ type: "ready" })
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line) as LifecycleRequest
    loseReply = request.type === "bash" && request.loseReply === true
    try {
      const value = await runtime.runPromise(Effect.gen(function* () { return yield* lifecycleRequest(yield* FilesystemWorkspace, yield* ObjectStorage, request) }))
      send({ type: "result", value })
    } catch (error) { send({ type: "error", message: String(error) }) }
  }
} finally { await runtime.dispose() }
