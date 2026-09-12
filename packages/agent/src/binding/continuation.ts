import { Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import type { ProviderContinuation } from "../inference/continuation"

export interface ReplayIdentity {
  readonly provider: string
  readonly protocol: string
  readonly model: string
}

export const replayOf = (continuation: ProviderContinuation | undefined, identity: ReplayIdentity): { readonly messages?: ReadonlyArray<Prompt.Message>; readonly reasoning: ReadonlyArray<string> } => {
  if (continuation === undefined) return { reasoning: [] }
  const native = Schema.decodeSync(Prompt.Prompt)(continuation.payload).content
  if (continuation.provider === identity.provider && continuation.protocol === identity.protocol && continuation.model === identity.model) return { messages: native, reasoning: [] }
  return { reasoning: native.flatMap((entry) => entry.role === "assistant"
    ? entry.content.flatMap((part) => part.type === "reasoning" && part.text.trim() !== "" ? [part.text] : [])
    : []) }
}
