import { Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import type { ProviderContinuation } from "../continuation"

export interface ReplayIdentity {
  readonly provider: string
  readonly protocol: string
  readonly model: string
}

export const replayOf = (continuation: ProviderContinuation | undefined, identity: ReplayIdentity): ReadonlyArray<Prompt.Message> | undefined => {
  if (continuation === undefined || continuation.provider !== identity.provider || continuation.protocol !== identity.protocol || continuation.model !== identity.model) return undefined
  return Schema.decodeSync(Prompt.Prompt)(continuation.payload).content
}
