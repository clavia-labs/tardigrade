import { Effect } from "effect"
import type { WorkspaceBackendService, WorkspaceReadResult } from "@clavia/tardigrade-libraries/workspace/index"
import type { ObjectRef, ObjectStorage } from "@clavia/tardigrade-store"

const encodedArtifact = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7X8AAAAASUVORK5CYII="
export const artifactBytes = Uint8Array.from(atob(encodedArtifact), character => character.charCodeAt(0))
export const publishArtifact = `printf '%s' '${encodedArtifact}' | base64 -d > artifact.png`
export const recordChange = "printf 'recorded\\n' >> changes.txt; printf 'recorded\\n'"

export interface WorkspaceLifecycleDriver {
  readonly bash: (command: string, key: string) => Promise<string>
  readonly read: (path: string) => Promise<WorkspaceReadResult>
  readonly resolve: (object: ObjectRef) => Promise<Uint8Array>
  readonly loseReply: (command: string, key: string) => Promise<void>
  readonly restart: () => Promise<void>
  readonly close: () => Promise<void>
}

export type WorkspaceCrashPoint = "afterClaim" | "beforeComplete" | "afterComplete"

export interface WorkspaceScenarioDriver extends WorkspaceLifecycleDriver {
  readonly interrupt: (command: string, key: string, fault: WorkspaceCrashPoint) => Promise<void>
  readonly write: (path: string, content: string, key: string) => Promise<void>
  readonly edit: (path: string, oldText: string, newText: string, key: string) => Promise<void>
}

export const WORKSPACE_SCENARIO_TIMEOUT_MS = 30_000

export type LifecycleRequest =
  | { readonly type: "bash"; readonly command: string; readonly key: string; readonly loseReply?: boolean; readonly fault?: WorkspaceCrashPoint }
  | { readonly type: "read"; readonly path: string }
  | { readonly type: "resolve"; readonly object: ObjectRef }

export type WorkspaceScenarioRequest = LifecycleRequest
  | { readonly type: "write"; readonly path: string; readonly content: string; readonly key: string }
  | { readonly type: "edit"; readonly path: string; readonly oldText: string; readonly newText: string; readonly key: string }

export type LifecycleResponse =
  | { readonly type: "ready" | "boundary" }
  | { readonly type: "result"; readonly value: unknown }
  | { readonly type: "error"; readonly message: string }

// lifecycleRequest dispatches fixture transport requests through workspace and content-store services.
export function lifecycleRequest(workspace: WorkspaceBackendService, objects: typeof ObjectStorage.Service, request: WorkspaceScenarioRequest): Effect.Effect<unknown, Error> {
  switch (request.type) {
    case "bash": return workspace.bash(request.command, { idempotencyKey: request.key })
    case "read": return workspace.read(request.path)
    case "resolve": return objects.get(request.object).pipe(Effect.map(bytes => Array.from(bytes)))
    case "write": return workspace.write(request.path, request.content, { idempotencyKey: request.key })
    case "edit": return workspace.edit(request.path, request.oldText, request.newText, { idempotencyKey: request.key })
  }
}
