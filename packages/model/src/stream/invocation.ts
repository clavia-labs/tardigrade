import { Effect, Option } from "effect"
import type { Response } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import type { ModelRef } from "../reference"
import { BindingSettings, CurrentModel, ProviderRequestKey } from "../settings"
import { observeResponse } from "./delivery"
import type { InferDelta, InferenceIdentity } from "./observer"

// withModelRequest scopes transport and observation to one request (delivery.test.ts).
export const withModelRequest = <A, E, R>(
  request: { readonly identity: InferenceIdentity; readonly model?: ModelRef | undefined; readonly observedModel?: ModelRef | undefined; readonly key?: string | undefined; readonly onDelta?: ((delta: InferDelta) => void) | undefined },
  use: (onPart: (part: Response.AnyPart) => Effect.Effect<void>) => Effect.Effect<A, E, R>
) => Effect.gen(function* () {
  const settings = yield* BindingSettings
  const delivery = yield* observeResponse(request.identity, request.observedModel ?? request.model ?? { provider: settings.provider, model_id: settings.model }, request.key, settings.observer, request.onDelta)
  const transport = Option.getOrElse(yield* Effect.serviceOption(FetchHttpClient.RequestInit), () => ({}))
  const fetchOptions = { ...transport, timeout: false }
  return yield* Effect.suspend(() => use(delivery.onPart)).pipe(
    Effect.provideService(CurrentModel, request.model),
    Effect.provideService(ProviderRequestKey, request.key),
    Effect.provideService(FetchHttpClient.RequestInit, fetchOptions),
    Effect.ensuring(delivery.finish)
  )
})
