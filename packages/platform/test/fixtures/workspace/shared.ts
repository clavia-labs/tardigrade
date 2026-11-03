import { Effect } from "effect"
import type { FilesystemWorkspaceService, WorkspaceReadResult } from "@clavia/tardigrade-libraries/filesystem/index"
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

export type LifecycleRequest =
  | { readonly type: "bash"; readonly command: string; readonly key: string; readonly loseReply?: boolean }
  | { readonly type: "read"; readonly path: string }
  | { readonly type: "resolve"; readonly object: ObjectRef }

export type LifecycleResponse =
  | { readonly type: "ready" | "boundary" }
  | { readonly type: "result"; readonly value: unknown }
  | { readonly type: "error"; readonly message: string }

// lifecycleRequest dispatches fixture transport requests through workspace and content-store services.
export function lifecycleRequest(workspace: FilesystemWorkspaceService, objects: typeof ObjectStorage.Service, request: LifecycleRequest): Effect.Effect<unknown, Error> {
  switch (request.type) {
    case "bash": return workspace.bash(request.command, { idempotencyKey: request.key })
    case "read": return workspace.read(request.path)
    case "resolve": return objects.get(request.object).pipe(Effect.map(bytes => Array.from(bytes)))
  }
}
