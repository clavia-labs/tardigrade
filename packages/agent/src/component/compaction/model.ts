import { Effect, Option } from "effect"
import { Toolkit, type Response } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import { collectResponse } from "@clavia/tardigrade-model/stream/collect"
import { observeResponse } from "@clavia/tardigrade-model/stream/delivery"
import { BindingSettings, CurrentModel, ProviderRequestKey } from "@clavia/tardigrade-model/settings"
import type { InferenceIdentity } from "@clavia/tardigrade-model/stream/observer"
import type { ModelRef } from "@clavia/tardigrade-model/reference"
import { unknownModelError } from "@clavia/tardigrade-model/error"

// summarize accepts a nonempty completed summary without tool calls (component/compaction.test.ts).
export const summarize = (prompt: string, identity: InferenceIdentity, model?: ModelRef) => Effect.gen(function* () {
  const settings = yield* BindingSettings
  const observer = yield* observeResponse(identity, model ?? { provider: settings.provider, model_id: settings.model }, identity.turn, settings.observer)
  const transport = Option.getOrElse(yield* Effect.serviceOption(FetchHttpClient.RequestInit), () => ({}))
  const fetchOptions = { ...transport, timeout: false }
  const response = yield* collectResponse(prompt, Toolkit.make(), observer.onPart, undefined, settings.policy.timeout).pipe(
    Effect.provideService(CurrentModel, model),
    Effect.provideService(ProviderRequestKey, identity.turn),
    Effect.provideService(FetchHttpClient.RequestInit, fetchOptions),
    Effect.ensuring(observer.finish)
  )
  const parts: ReadonlyArray<Response.AnyPart> = response.parts
  const error = parts.find(part => part.type === "error")
  if (error?.type === "error") return yield* unknownModelError(error.error)
  const finish = parts.findLast(part => part.type === "finish")
  const text = parts.flatMap(part => part.type === "text-delta" ? [part.delta] : []).join("")
  if ((finish?.reason !== "stop" && finish?.reason !== "tool-calls") || parts.some(part => part.type === "tool-call") || text.trim() === "") {
    return yield* unknownModelError("Compaction requires a nonempty completed summary without tool calls")
  }
  return text
})
