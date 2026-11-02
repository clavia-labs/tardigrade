import { DurableObject } from "cloudflare:workers"
import { Effect, ManagedRuntime, type Layer } from "effect"
import { FilesystemWorkspace } from "@clavia/tardigrade-libraries/filesystem/index"

// workspaceObject exposes a scoped workspace layer through Durable Object RPC.
export function workspaceObject<Env extends object = Record<string, unknown>>(layer: (ctx: DurableObjectState, env: Env) => Layer.Layer<FilesystemWorkspace, Error>) {
  return class WorkspaceObject extends DurableObject<Env> {
    private readonly runtime = ManagedRuntime.make(layer(this.ctx, this.env))
    bash(command: string) { return this.runtime.runPromise(Effect.flatMap(FilesystemWorkspace, workspace => workspace.bash(command))) }
    read(path: string) { return this.runtime.runPromise(Effect.flatMap(FilesystemWorkspace, workspace => workspace.read(path))) }
    write(path: string, content: string) { return this.runtime.runPromise(Effect.flatMap(FilesystemWorkspace, workspace => workspace.write(path, content))) }
    edit(path: string, oldText: string, newText: string) { return this.runtime.runPromise(Effect.flatMap(FilesystemWorkspace, workspace => workspace.edit(path, oldText, newText))) }
    close() { return this.runtime.dispose() }
  }
}
