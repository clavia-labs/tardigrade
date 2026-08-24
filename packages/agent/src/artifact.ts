import type { Actor } from "@clavia/tardigrade-core/actor"
import { actorMethodsOf, type ActorMethods } from "./method"

export const ACTOR_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u

export const ACTOR_ARTIFACT_VERSION = 2

export interface ActorArtifactManifest {
  readonly schema: typeof ACTOR_ARTIFACT_VERSION
  readonly name: string
  readonly module: string
  readonly digest: string
}

export interface ActorDefinition<R = never, Methods extends ActorMethods = ActorMethods> {
  readonly name: string
  readonly actor: Actor<R>
  readonly methods: Methods
}

export const defineActor = <R, const Methods extends ActorMethods>(
  definition: ActorDefinition<R, Methods>
): ActorDefinition<R, Methods> => {
  if (!ACTOR_NAME_PATTERN.test(definition.name)) {
    throw new Error(`actor name must match ${String(ACTOR_NAME_PATTERN)}, got ${JSON.stringify(definition.name)}`)
  }
  actorMethodsOf(definition.methods)
  return definition
}
