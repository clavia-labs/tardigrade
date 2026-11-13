import { Effect, Layer, Option } from "effect"
import { EffectExecution } from "@clavia/tardigrade-core"
import { workspace } from "@clavia/tardigrade-libraries/workspace/index"
import { WorkspaceBackend, type WorkspaceBackendService } from "@clavia/tardigrade-libraries/workspace/index"

// workspaceService adapts backend operations and preserves durable mutation keys (test/scenarios/workspace/lifecycle.ts).
export const workspaceService = Layer.effect(workspace, Effect.map(WorkspaceBackend, backend => ({
  bash: ({ command }, request) => mutation(backend, request?.requestId, options => backend.bash(command, options)),
  read: ({ path, ...range }) => backend.read(path, range).pipe(Effect.map(value => ({ content: [typeof value === "string" ? { type: "text" as const, text: value } : value] })), Effect.mapError(String)),
  write: ({ path, content }, request) => mutation(backend, request?.requestId, options => backend.write(path, content, options)).pipe(Effect.as(`Wrote ${path}`)),
  edit: ({ path, oldText, newText }, request) => mutation(backend, request?.requestId, options => backend.edit(path, oldText, newText, options)).pipe(Effect.as(`Edited ${path}`)),
} satisfies typeof workspace.Service)))

function mutation<Value>(workspace: WorkspaceBackendService, requestId: string | number | undefined, execute: (options: { readonly idempotencyKey: string } | undefined) => Effect.Effect<Value, Error>) {
  return Effect.gen(function* () {
    if (!workspace.idempotency || requestId === undefined) return yield* execute(undefined)
    const current = yield* Effect.serviceOption(EffectExecution)
    const ref = Option.isSome(current) ? current.value.ref : undefined
    const idempotencyKey = JSON.stringify(["filesystem-tool-v1", ref ? [ref.seq, ref.atom, ref.act] : null, String(requestId)])
    return yield* execute({ idempotencyKey })
  }).pipe(Effect.mapError(String))
}
