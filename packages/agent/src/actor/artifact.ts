export {
  ACTOR_NAME_PATTERN
} from "@clavia/tardigrade-core/actor"

export const ACTOR_ARTIFACT_VERSION = 4

export interface ActorArtifactManifest {
  readonly schema: typeof ACTOR_ARTIFACT_VERSION
  readonly name: string
  readonly module: string
  readonly digest: string
}
