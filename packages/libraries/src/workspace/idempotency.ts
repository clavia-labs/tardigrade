import { Effect } from "effect"
import { WorkspaceError, type WorkspaceBackendService } from "./backend"

export interface WorkspaceMutationOptions {
  readonly idempotencyKey?: string
}

export interface WorkspaceIdempotencyRequest {
  readonly workspaceId: string
  readonly key: string
  readonly inputDigest: string
}

export type WorkspaceMutationOutcome =
  | { readonly _tag: "Success"; readonly value: string | null }
  | { readonly _tag: "Failure"; readonly message: string }

export type WorkspaceIdempotencyClaim =
  | { readonly _tag: "Acquired" }
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Completed"; readonly outcome: WorkspaceMutationOutcome }
  | { readonly _tag: "Conflict" }

// WorkspaceIdempotencyStore defines persistence operations for keyed workspace mutations.
export interface WorkspaceIdempotencyStore {
  readonly claim: (request: WorkspaceIdempotencyRequest) => Effect.Effect<WorkspaceIdempotencyClaim, WorkspaceError>
  readonly complete: (request: WorkspaceIdempotencyRequest, outcome: WorkspaceMutationOutcome) => Effect.Effect<void, WorkspaceError>
}

export interface WorkspaceIdempotencyOptions {
  readonly workspaceId: string
  readonly store: WorkspaceIdempotencyStore
}

export class WorkspaceIdempotencyError extends WorkspaceError {
  constructor(readonly reason: "unsupported" | "conflict" | "pending", message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

// workspaceIdempotency adapts workspace mutations to the configured replay store.
export function workspaceIdempotency(workspace: WorkspaceBackendService, options: WorkspaceIdempotencyOptions | undefined, configuration: readonly unknown[], validate: (method: "bash" | "write" | "edit", args: readonly string[]) => void): WorkspaceBackendService {
  const run = <Value extends string | void>(method: "bash" | "write" | "edit", args: readonly string[], mutation: WorkspaceMutationOptions | undefined, execute: Effect.Effect<Value, WorkspaceError>): Effect.Effect<Value, WorkspaceError> => Effect.gen(function* () {
    const key = mutation?.idempotencyKey
    if (key === undefined) return yield* execute
    if (typeof key !== "string" || !key.trim()) return yield* Effect.fail(new WorkspaceError("Idempotency key must be nonempty"))
    if (!options) return yield* Effect.fail(new WorkspaceIdempotencyError("unsupported", "Workspace has no idempotency store"))
    yield* Effect.try({ try: () => {
      if (typeof options.workspaceId !== "string" || !options.workspaceId.trim()) throw new WorkspaceError("Workspace identity must be nonempty")
      for (const arg of args) if (typeof arg !== "string") throw new WorkspaceError("Workspace mutation arguments must be strings")
      if (method === "bash" && args[0]!.includes("\0")) throw new WorkspaceError("Command must contain no NUL")
      validate(method, args)
      if (method === "edit" && !args[1]) throw new WorkspaceError("oldText must not be empty")
    }, catch: WorkspaceError.from })
    const inputDigest = yield* Effect.tryPromise({ try: async () => {
      const bytes = new TextEncoder().encode(JSON.stringify(["workspace-mutation-v1", configuration, method, args], (_key, value: unknown) => {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return value
        return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
      }))
      const digest = await crypto.subtle.digest("SHA-256", bytes)
      return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")
    }, catch: WorkspaceError.from })
    const request = { workspaceId: options.workspaceId, key, inputDigest }
    const claim = yield* options.store.claim(request)
    if (claim._tag === "Conflict") return yield* Effect.fail(new WorkspaceIdempotencyError("conflict", "Idempotency key was used with different workspace inputs"))
    if (claim._tag === "Pending") return yield* Effect.fail(new WorkspaceIdempotencyError("pending", "Workspace mutation is pending or its outcome is unknown; re-execution is blocked"))
    const replay = (outcome: WorkspaceMutationOutcome): Effect.Effect<Value, WorkspaceError> => {
      if (outcome._tag === "Failure") return Effect.fail(new WorkspaceError(outcome.message, { outcome: "terminal" }))
      if (method === "bash" ? typeof outcome.value !== "string" : outcome.value !== null) return Effect.fail(new WorkspaceError("Stored workspace outcome does not match the mutation"))
      return Effect.succeed((outcome.value === null ? undefined : outcome.value) as Value)
    }
    if (claim._tag === "Completed") return yield* replay(claim.outcome)
    const result = yield* Effect.result(execute)
    if (result._tag === "Failure" && result.failure.outcome !== "terminal") return yield* Effect.fail(new WorkspaceIdempotencyError("pending", "Workspace mutation outcome is unknown; re-execution is blocked", { cause: result.failure }))
    const outcome: WorkspaceMutationOutcome = result._tag === "Success"
      ? { _tag: "Success", value: result.success ?? null }
      : { _tag: "Failure", message: result.failure.message }
    yield* options.store.complete(request, outcome).pipe(Effect.mapError(cause => new WorkspaceIdempotencyError("pending", "Workspace mutation outcome could not be saved; re-execution is blocked", { cause })))
    return yield* replay(outcome)
  })
  return {
    ...(options ? { idempotency: { workspaceId: options.workspaceId } } : {}),
    read: workspace.read,
    bash: (command, mutation) => run("bash", [command], mutation, workspace.bash(command)),
    write: (path, content, mutation) => run("write", [path, content], mutation, workspace.write(path, content)),
    edit: (path, oldText, newText, mutation) => run("edit", [path, oldText, newText], mutation, workspace.edit(path, oldText, newText)),
  }
}
