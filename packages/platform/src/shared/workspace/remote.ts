import { Effect, Layer } from "effect"
import { FilesystemWorkspace, FilesystemWorkspaceError } from "@clavia/tardigrade-libraries/filesystem/index"

export interface RemoteWorkspace {
  readonly bash: (command: string) => Promise<string>
  readonly read: (path: string) => Promise<string>
  readonly write: (path: string, content: string) => Promise<void>
  readonly edit: (path: string, oldText: string, newText: string) => Promise<void>
}

// remoteWorkspace supplies the filesystem capability through a workspace RPC stub.
export function remoteWorkspace(remote: RemoteWorkspace): Layer.Layer<FilesystemWorkspace> {
  return Layer.succeed(FilesystemWorkspace)({
    bash: command => Effect.tryPromise({ try: () => remote.bash(command), catch: FilesystemWorkspaceError.from }),
    read: path => Effect.tryPromise({ try: () => remote.read(path), catch: FilesystemWorkspaceError.from }),
    write: (path, content) => Effect.tryPromise({ try: () => remote.write(path, content), catch: FilesystemWorkspaceError.from }),
    edit: (path, oldText, newText) => Effect.tryPromise({ try: () => remote.edit(path, oldText, newText), catch: FilesystemWorkspaceError.from }),
  })
}
