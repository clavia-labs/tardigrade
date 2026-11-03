import { Database } from "bun:sqlite"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { Effect, Layer, ManagedRuntime } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { FilesystemWorkspace } from "@clavia/tardigrade-libraries/filesystem/index"
import { localWorkspace } from "../../../src/bun/workspace"
import { sqlIdempotencyStore } from "../../../src/shared/workspace/idempotency-store"
import type { Fault, Outcome, Request, Response, Snapshot } from "../workspace-idempotency-protocol"
import { workspaceFaultStore, workspaceMutation } from "../workspace-idempotency"

const directory = process.argv[2]!
const filename = join(directory, "state.sqlite")
let fault: Fault = "none"
const send = (response: Response) => process.stdout.write(`${JSON.stringify(response)}\n`)
const pause = (boundary: Fault) => Effect.sync(() => { send({ type: "boundary", fault: boundary }) }).pipe(Effect.andThen(Effect.never))
const runtimes = Array.from({ length: 2 }, (_, workspace) => Array.from({ length: 2 }, () => ManagedRuntime.make(
  Layer.unwrap(Effect.gen(function* () {
    const store = yield* sqlIdempotencyStore
    const interrupted = workspaceFaultStore(store, () => fault, pause)
    return localWorkspace({ directory: join(directory, String(workspace)), idempotency: { workspaceId: String(workspace), store: interrupted } })
  })).pipe(Layer.provide(SqliteClient.layer({ filename }))),
)))

const text = async (path: string): Promise<string | null> => {
  try { return await readFile(path, "utf8") } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  }
}

async function handle(request: Request): Promise<Response> {
  if (request.type === "snapshot") {
    const db = new Database(filename, { readonly: true })
    try {
      const rows = db.query<Snapshot["rows"][number], []>("SELECT workspace_id, caller_key, input_digest, outcome FROM workspace_idempotency ORDER BY workspace_id, caller_key").all()
      const logs = await Promise.all([0, 1].map(async workspace => await text(join(directory, String(workspace), "calls.log")) ?? ""))
      const files = await Promise.all([0, 1].map(workspace => text(join(directory, String(workspace), "file.txt"))))
      return { type: "snapshot", snapshot: { rows, logs, files, outside: await text(join(directory, "outside.txt")) } }
    } finally { db.close() }
  }
  fault = request.fault
  const outcomes = await Promise.all(Array.from({ length: request.copies }, async (_, index): Promise<Outcome> => {
    const runtime = runtimes[request.workspace]![index % 2]!
    return runtime.runPromise(Effect.gen(function* () {
      const workspace = yield* FilesystemWorkspace
      return yield* workspaceMutation(workspace, request)
    }))
  }))
  return { type: "result", outcomes }
}

try {
  for (const runtime of runtimes.flat()) await runtime.context()
  send({ type: "ready" })
  for await (const line of createInterface({ input: process.stdin })) send(await handle(JSON.parse(line) as Request))
} catch (error) {
  send({ type: "fatal", message: error instanceof Error ? error.stack ?? error.message : String(error) })
  process.exitCode = 1
} finally {
  for (const runtime of runtimes.flat()) await runtime.dispose()
}
