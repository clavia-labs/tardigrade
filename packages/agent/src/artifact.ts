import type { Actor } from "@clavia/tardigrade-core/actor"

export const ACTOR_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u

export const ACTOR_ARTIFACT_VERSION = 1

export interface ActorArtifactManifest {
  readonly schema: typeof ACTOR_ARTIFACT_VERSION
  readonly name: string
  readonly module: string
  readonly digest: string
}

export interface ActorDefinition<R = never> {
  readonly name: string
  readonly actor: Actor<R>
}

export const defineActor = <R>(definition: ActorDefinition<R>): ActorDefinition<R> => {
  if (!ACTOR_NAME_PATTERN.test(definition.name)) {
    throw new Error(`actor name must match ${String(ACTOR_NAME_PATTERN)}, got ${JSON.stringify(definition.name)}`)
  }
  return definition
}
