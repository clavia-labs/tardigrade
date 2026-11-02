import { Layer } from "effect"
import { workspaceObject } from "./workspace-object"
import { SqliteClient } from "@effect/sql-sqlite-do"
import { virtualWorkspace as sqliteVirtualWorkspace, type VirtualWorkspaceOptions } from "../shared/workspace/virtual/index"

// virtualWorkspace stores virtual files in Durable Object SQLite; executor selects where shell interpretation runs.
export function virtualWorkspace(storage: DurableObjectStorage, options: VirtualWorkspaceOptions) {
  return sqliteVirtualWorkspace(options).pipe(Layer.provide(SqliteClient.layer({ storage })))
}

// createVirtualWorkspaceObject exposes a SQLite-backed virtual workspace through Durable Object RPC.
export function createVirtualWorkspaceObject(options: VirtualWorkspaceOptions) {
  return workspaceObject(ctx => virtualWorkspace(ctx.storage, options))
}
