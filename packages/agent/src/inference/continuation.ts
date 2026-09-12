import { Schema } from "effect"
import { Prompt } from "effect/unstable/ai"

// ProviderContinuation preserves encoded prompt evidence for compatible replay (binding/continuation.test.ts).
export const ProviderContinuation = Schema.Struct({
  format: Schema.Literal("effect-prompt"),
  protocol: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  endpoint: Schema.String,
  payload: Schema.toEncoded(Prompt.Prompt)
})
export type ProviderContinuation = typeof ProviderContinuation.Type

// continuationOf accepts current prompts and historical arrays without inventing native content.
export const continuationOf = (value: unknown): ProviderContinuation | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const source = value as Record<string, unknown>
  const candidate = source.format === "effect-prompt" && Array.isArray(source.payload)
    ? { ...source, payload: { content: source.payload } }
    : source
  return Schema.is(ProviderContinuation)(candidate) ? candidate : undefined
}
