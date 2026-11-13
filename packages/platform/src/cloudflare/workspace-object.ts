import { DurableObject } from "cloudflare:workers"
import { Effect, Layer, ManagedRuntime, Scheduler } from "effect"
import { WorkspaceBackend, type WorkspaceMutationOptions, type WorkspaceReadRange } from "@clavia/tardigrade-libraries/workspace/index"

// workspaceObject uses microtask continuations across DO SQL transactions (test/workerd/workspace/lifecycle.workers.ts).
export function workspaceObject<Env extends object = Record<string, unknown>>(layer: (ctx: DurableObjectState, env: Env) => Layer.Layer<WorkspaceBackend, Error>) {
  return class WorkspaceObject extends DurableObject<Env> {
    private readonly runtime = ManagedRuntime.make(layer(this.ctx, this.env).pipe(Layer.provideMerge(Layer.succeed(Scheduler.Scheduler, new Scheduler.MixedScheduler("sync")))))
    idempotency() { return this.runtime.runPromise(Effect.map(WorkspaceBackend, workspace => workspace.idempotency ?? null)) }
    bash(command: string, options?: WorkspaceMutationOptions) { return this.runtime.runPromise(Effect.flatMap(WorkspaceBackend, workspace => workspace.bash(command, options))) }
    read(path: string, range?: WorkspaceReadRange) { return this.runtime.runPromise(Effect.flatMap(WorkspaceBackend, workspace => workspace.read(path, range))) }
    write(path: string, content: string, options?: WorkspaceMutationOptions) { return this.runtime.runPromise(Effect.flatMap(WorkspaceBackend, workspace => workspace.write(path, content, options))) }
    edit(path: string, oldText: string, newText: string, options?: WorkspaceMutationOptions) { return this.runtime.runPromise(Effect.flatMap(WorkspaceBackend, workspace => workspace.edit(path, oldText, newText, options))) }
    close() { return this.runtime.dispose() }
  }
}
