import { Context, Effect } from "effect"

// FilesystemWorkspaceError preserves filesystem and command failures at the workspace boundary.
export class FilesystemWorkspaceError extends Error {
  readonly _tag = "FilesystemWorkspaceError"
  static from(cause: unknown): FilesystemWorkspaceError {
    return cause instanceof FilesystemWorkspaceError ? cause : new FilesystemWorkspaceError(cause instanceof Error ? cause.message : String(cause), { cause })
  }
}

export interface FilesystemWorkspaceService {
  readonly bash: (command: string) => Effect.Effect<string, FilesystemWorkspaceError>
  readonly read: (path: string) => Effect.Effect<string, FilesystemWorkspaceError>
  readonly write: (path: string, content: string) => Effect.Effect<void, FilesystemWorkspaceError>
  readonly edit: (path: string, oldText: string, newText: string) => Effect.Effect<void, FilesystemWorkspaceError>
}

// FilesystemWorkspace supplies file and shell operations to tool implementations.
export class FilesystemWorkspace extends Context.Service<FilesystemWorkspace, FilesystemWorkspaceService>()("tardie/FilesystemWorkspace") {}

export interface FilesystemWorkspacePolicy {
  readonly commandTimeoutMs: number
  readonly maxOutputChars: number
  readonly maxReadChars: number
}
export const DEFAULT_FILESYSTEM_WORKSPACE_POLICY: FilesystemWorkspacePolicy = { commandTimeoutMs: 30_000, maxOutputChars: 32_768, maxReadChars: 32_768 }

// filesystemWorkspacePolicy validates the resource bounds exposed by workspace layers.
export function filesystemWorkspacePolicy(options: Partial<FilesystemWorkspacePolicy> = {}): FilesystemWorkspacePolicy {
  const policy = { ...DEFAULT_FILESYSTEM_WORKSPACE_POLICY, ...options }
  for (const [name, value] of Object.entries(policy)) if (!Number.isSafeInteger(value) || value < 1) throw new FilesystemWorkspaceError(`${name} must be a positive safe integer`)
  return policy
}

// workspaceText marks omitted text with the applied character bound.
export function workspaceText(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated: ${text.length} characters, limit ${limit}]`
}

// editWorkspaceText requires one nonempty literal match before changing a file.
export function editWorkspaceText(text: string, oldText: string, newText: string): string {
  if (!oldText) throw new FilesystemWorkspaceError("oldText must not be empty")
  const first = text.indexOf(oldText)
  if (first < 0 || text.indexOf(oldText, first + oldText.length) >= 0) throw new FilesystemWorkspaceError("Expected oldText exactly once in the file")
  return text.slice(0, first) + newText + text.slice(first + oldText.length)
}
