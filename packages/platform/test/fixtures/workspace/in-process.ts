import { Effect, ManagedRuntime } from "effect"
import { SqlClient } from "effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { editWorkspaceText, FilesystemWorkspaceError, workspaceIdempotency, WorkspaceIdempotencyError, type FilesystemWorkspaceService } from "@clavia/tardigrade-libraries/filesystem/index"
import { sqlIdempotencyStore } from "../../../src/shared/workspace/idempotency-store"
import { workspaceFaultStore } from "./idempotency"
import type { Fault, Outcome, Request, Response, Snapshot } from "./protocol"

// inProcessWorkspaceIdempotency exercises the real wrapper and SQL store with deterministic execution failures.
export async function inProcessWorkspaceIdempotency() {
  const runtime = ManagedRuntime.make(SqliteClient.layer({ filename: ":memory:" }))
  try {
    const store = await runtime.runPromise(sqlIdempotencyStore)
    const logs = ["", ""]
    const files: Array<string | null> = [null, null]
    let fault: Fault = "none"
    let boundary: Fault | undefined
    const interrupted = workspaceFaultStore(store, () => fault, point => Effect.sync(() => { boundary = point }).pipe(
      Effect.andThen(Effect.interrupt),
    ))
    const restore = () => [0, 1].map(index => workspaceIdempotency({
      bash: command => Effect.sync(() => { logs[index] += `${command}\n`; return logs[index]! }),
      read: () => Effect.sync(() => files[index] ?? ""),
      write: (_path, content) => Effect.sync(() => { files[index] = content }),
      edit: (_path, oldText, newText) => Effect.try({
        try: () => { files[index] = editWorkspaceText(files[index] ?? "", oldText, newText) }, catch: FilesystemWorkspaceError.from,
      }),
    } satisfies FilesystemWorkspaceService, { workspaceId: String(index), store: interrupted }, ["in-process"], (method, args) => {
      if (method !== "bash" && args[0] !== "file.txt") throw new FilesystemWorkspaceError("Path is outside the workspace directory")
    }))
    let workspaces = restore()
    const failure = (error: unknown): Outcome => ({
      status: "error", message: error instanceof Error ? error.message : String(error),
      reason: error instanceof WorkspaceIdempotencyError ? error.reason
        : error instanceof FilesystemWorkspaceError && error.outcome === "terminal" ? "terminal" : "storage",
    })
    return {
      request: async (input: Request): Promise<Response> => {
        if (input.type === "snapshot") {
          const rows = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql<Snapshot["rows"][number]>`SELECT workspace_id, caller_key, input_digest, outcome FROM workspace_idempotency ORDER BY workspace_id, caller_key`))
          return { type: "snapshot", snapshot: { rows, logs: [...logs], files: [...files], outside: null } }
        }
        fault = input.fault
        boundary = undefined
        const workspace = workspaces[input.workspace]!
        const options = { idempotencyKey: input.key }
        const execute = () => {
          switch (input.mutation.method) {
            case "append": return workspace.bash(String(input.mutation.value), options)
            case "write": return workspace.write("file.txt", input.mutation.content, options)
            case "edit": return workspace.edit("file.txt", input.mutation.oldText, input.mutation.newText, options)
            case "invalid": return workspace.write("../outside.txt", "invalid", options)
          }
        }
        const outcomes = await Promise.all(Array.from({ length: input.copies }, async (): Promise<Outcome> => {
          try { return { status: "success", value: await runtime.runPromise(execute()) ?? null } } catch (error) { return failure(error) }
        }))
        return boundary ? { type: "boundary", fault: boundary, outcomes } : { type: "result", outcomes }
      },
      restart: async () => { fault = "none"; workspaces = restore() },
      close: () => runtime.dispose(),
    }
  } catch (error) { await runtime.dispose(); throw error }
}
