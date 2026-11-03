import { Effect, Layer } from "effect"
import { FilesystemWorkspace, FilesystemWorkspaceError, WorkspaceIdempotencyError, type FilesystemWorkspaceService, type WorkspaceMutationOptions, type WorkspaceReadResult, type WorkspaceReadRange } from "@clavia/tardigrade-libraries/filesystem/index"

export interface RemoteWorkspace {
  readonly idempotency?: () => Promise<{ readonly workspaceId: string } | null>
  readonly bash: (command: string, options?: WorkspaceMutationOptions) => Promise<string>
  readonly read: (path: string, range?: WorkspaceReadRange) => Promise<WorkspaceReadResult>
  readonly write: (path: string, content: string, options?: WorkspaceMutationOptions) => Promise<void>
  readonly edit: (path: string, oldText: string, newText: string, options?: WorkspaceMutationOptions) => Promise<void>
}

// remoteWorkspace supplies the filesystem capability through a workspace RPC stub.
export function remoteWorkspace(remote: RemoteWorkspace): Layer.Layer<FilesystemWorkspace, FilesystemWorkspaceError> {
  return Layer.effect(FilesystemWorkspace, Effect.gen(function* () {
    const idempotency = yield* Effect.tryPromise({ try: async () => remote.idempotency ? remote.idempotency() : null, catch: FilesystemWorkspaceError.from })
    const mutation = <Value>(options: WorkspaceMutationOptions | undefined, execute: () => Promise<Value>) => {
      if (options?.idempotencyKey !== undefined && !idempotency) return Effect.fail(new WorkspaceIdempotencyError("unsupported", "Remote workspace has no idempotency store"))
      return Effect.tryPromise({ try: execute, catch: FilesystemWorkspaceError.from })
    }
    return {
      ...(idempotency ? { idempotency } : {}),
      bash: (command, options) => mutation(options, () => remote.bash(command, options)),
      read: (path, range) => Effect.tryPromise({ try: () => remote.read(path, range), catch: FilesystemWorkspaceError.from }),
      write: (path, content, options) => mutation(options, () => remote.write(path, content, options)),
      edit: (path, oldText, newText, options) => mutation(options, () => remote.edit(path, oldText, newText, options)),
    } satisfies FilesystemWorkspaceService
  }))
}
