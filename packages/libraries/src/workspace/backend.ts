import { Context, Effect } from "effect"
import type { WorkspaceMutationOptions } from "./idempotency"
import type { WorkspaceReadResult, WorkspaceReadRange } from "./read"

// WorkspaceError preserves filesystem and command failures at the workspace boundary.
export class WorkspaceError extends Error {
  readonly _tag = "WorkspaceError"
  readonly outcome: "terminal" | "unknown"
  constructor(message: string, options?: ErrorOptions & { readonly outcome?: "terminal" | "unknown" }) {
    super(message, options)
    this.outcome = options?.outcome ?? "unknown"
  }
  static from(cause: unknown): WorkspaceError {
    return cause instanceof WorkspaceError ? cause : new WorkspaceError(cause instanceof Error ? cause.message : String(cause), { cause })
  }
}

export interface WorkspaceBackendService {
  readonly idempotency?: { readonly workspaceId: string }
  readonly bash: (command: string, options?: WorkspaceMutationOptions) => Effect.Effect<string, WorkspaceError>
  readonly read: (path: string, range?: WorkspaceReadRange) => Effect.Effect<WorkspaceReadResult, WorkspaceError>
  readonly write: (path: string, content: string, options?: WorkspaceMutationOptions) => Effect.Effect<void, WorkspaceError>
  readonly edit: (path: string, oldText: string, newText: string, options?: WorkspaceMutationOptions) => Effect.Effect<void, WorkspaceError>
}

// WorkspaceBackend supplies file and shell operations to tool implementations.
export class WorkspaceBackend extends Context.Service<WorkspaceBackend, WorkspaceBackendService>()("tardie/WorkspaceBackend") {}

export interface WorkspacePolicy {
  readonly commandTimeoutMs: number
  readonly maxOutputChars: number
  readonly maxReadChars: number
}
export const DEFAULT_WORKSPACE_POLICY: WorkspacePolicy = { commandTimeoutMs: 30_000, maxOutputChars: 32_768, maxReadChars: 32_768 }

// workspacePolicy validates the resource bounds exposed by workspace layers.
export function workspacePolicy(options: Partial<WorkspacePolicy> = {}): WorkspacePolicy {
  const policy = { ...DEFAULT_WORKSPACE_POLICY, ...options }
  for (const [name, value] of Object.entries(policy)) if (!Number.isSafeInteger(value) || value < 1) throw new WorkspaceError(`${name} must be a positive safe integer`)
  return policy
}

// workspaceText marks omitted text with the applied character bound.
export function workspaceText(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated: ${text.length} characters, limit ${limit}]`
}

// editWorkspaceText requires one nonempty literal match before changing a file.
export function editWorkspaceText(text: string, oldText: string, newText: string): string {
  if (!oldText) throw new WorkspaceError("oldText must not be empty", { outcome: "terminal" })
  const first = text.indexOf(oldText)
  if (first < 0 || text.indexOf(oldText, first + oldText.length) >= 0) throw new WorkspaceError("Expected oldText exactly once in the file", { outcome: "terminal" })
  return text.slice(0, first) + newText + text.slice(first + oldText.length)
}
