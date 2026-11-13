import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { WorkspaceError } from "@clavia/tardigrade-libraries/workspace/index"
import { virtualWorkspace as sqliteVirtualWorkspace, type VirtualWorkspaceOptions } from "../shared/workspace/virtual/index"

export interface BunVirtualWorkspaceOptions extends VirtualWorkspaceOptions {
  readonly filename: string
}

// virtualWorkspace stores virtual files in a Bun SQLite database without accessing host files from shell commands.
export function virtualWorkspace(options: BunVirtualWorkspaceOptions) {
  const sqlite = Layer.unwrap(Effect.tryPromise({
    try: async () => {
      if (options.filename !== ":memory:") await mkdir(dirname(options.filename), { recursive: true })
      return SqliteClient.layer({ filename: options.filename })
    }, catch: WorkspaceError.from,
  }))
  return sqliteVirtualWorkspace(options).pipe(Layer.provide(sqlite))
}
