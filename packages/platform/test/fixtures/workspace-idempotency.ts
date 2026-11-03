import { Effect } from "effect"
import { FilesystemWorkspaceError, WorkspaceIdempotencyError, type FilesystemWorkspaceService, type WorkspaceIdempotencyStore } from "@clavia/tardigrade-libraries/filesystem/index"
import type { Fault, Outcome, Request } from "./workspace-idempotency-protocol"

// workspaceFaultStore applies shared failure boundaries around a real idempotency store.
export function workspaceFaultStore(store: WorkspaceIdempotencyStore, readFault: () => Fault, interrupt: (fault: Fault) => Effect.Effect<never>): WorkspaceIdempotencyStore {
  return {
    claim: request => Effect.gen(function* () {
      const fault = readFault()
      if (fault === "claimFailure") return yield* Effect.fail(new FilesystemWorkspaceError("Injected claim storage failure"))
      const claim = yield* store.claim(request)
      if (claim._tag === "Acquired" && fault === "afterClaim") return yield* interrupt(fault)
      return claim
    }),
    complete: (request, outcome) => Effect.gen(function* () {
      const fault = readFault()
      if (fault === "beforeComplete") return yield* interrupt(fault)
      yield* store.complete(request, outcome)
      if (fault === "afterComplete") return yield* interrupt(fault)
    }),
  }
}

// workspaceMutationFailure maps native and RPC failures to the shared property protocol.
export function workspaceMutationFailure(error: unknown): Outcome {
  const message = error instanceof Error ? error.message : String(error)
  const reason = error instanceof WorkspaceIdempotencyError ? error.reason
    : error instanceof FilesystemWorkspaceError && error.outcome === "terminal" ? "terminal"
    : message.includes("different workspace inputs") ? "conflict"
    : message.includes("re-execution is blocked") ? "pending"
    : message.includes("no idempotency store") ? "unsupported"
    : message === "Expected oldText exactly once in the file" ? "terminal" : "storage"
  return { status: "error", reason, message }
}

// workspaceMutation invokes filesystem operations through the supplied workspace service.
export function workspaceMutation(workspace: FilesystemWorkspaceService, request: Pick<Extract<Request, { type: "call" }>, "key" | "mutation">): Effect.Effect<Outcome> {
  const options = { idempotencyKey: request.key }
  const execute = (): Effect.Effect<string | void, FilesystemWorkspaceError> => {
    switch (request.mutation.method) {
      case "append": return workspace.bash(`printf '%s\\n' '${request.mutation.value}' >> calls.log; cat calls.log`, options)
      case "write": return workspace.write("file.txt", request.mutation.content, options)
      case "edit": return workspace.edit("file.txt", request.mutation.oldText, request.mutation.newText, options)
      case "invalid": return workspace.write("../outside.txt", "invalid", options)
    }
  }
  return execute().pipe(Effect.match({ onSuccess: value => ({ status: "success" as const, value: value ?? null }), onFailure: workspaceMutationFailure }))
}
