import { Effect, Layer } from "effect"
import { ObjectStorage } from "@clavia/tardigrade-store"
import { workspaceObject } from "./workspace-object"
import { SqliteClient } from "@effect/sql-sqlite-do"
import { virtualWorkspace as sqliteVirtualWorkspace, type VirtualWorkspaceOptions } from "../shared/workspace/virtual/index"

// virtualWorkspace stores virtual files in Durable Object SQLite; executor selects where shell interpretation runs.
export function virtualWorkspace(storage: DurableObjectStorage, options: VirtualWorkspaceOptions) {
  return sqliteVirtualWorkspace(options).pipe(Layer.provide(SqliteClient.layer({ storage })))
}

export interface VirtualWorkspaceObjectOptions<Env extends object> extends Omit<VirtualWorkspaceOptions, "contentStore"> {
  readonly contentStore?: (ctx: DurableObjectState, env: Env) => Layer.Layer<ObjectStorage, Error>
}

// createVirtualWorkspaceObject exposes a SQLite-backed virtual workspace through Durable Object RPC.
export function createVirtualWorkspaceObject<Env extends object = Record<string, unknown>>(options: VirtualWorkspaceObjectOptions<Env>) {
  return workspaceObject<Env>((ctx, env) => {
    const { contentStore, ...config } = options
    return contentStore
      ? Layer.unwrap(Effect.map(ObjectStorage, store => virtualWorkspace(ctx.storage, { ...config, contentStore: store }))).pipe(Layer.provide(contentStore(ctx, env)))
      : virtualWorkspace(ctx.storage, config)
  })
}
