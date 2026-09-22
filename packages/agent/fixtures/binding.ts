import { Cause, Effect, Layer } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import type { Action } from "../src/log/events"
import { BindingSettings, ModelSelection } from "../src/model/execution/settings"
import { react } from "../src/model/execution/index"

// inferenceClient captures an Effect model for direct binding tests.
export const inferenceClient = Effect.gen(function* () {
  const context = yield* Effect.context<LanguageModel.LanguageModel>()
  const settings = yield* BindingSettings
  const registry = yield* ModelSelection
  return {
    layer: Layer.succeedContext(context),
    model: { provider: settings.provider, model_id: settings.model },
    policy: () => Effect.succeed(settings.policy),
    pricing: () => Effect.succeed(settings.pricing),
    react: (...args: Parameters<typeof react>) => Effect.gen(function* () {
      const current = yield* (registry.settings?.(args[0].model) ?? Effect.succeed(settings))
      return yield* react(...args).pipe(Effect.provideService(BindingSettings, current))
    }).pipe(Effect.provide(context), Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.succeed<Action>({ kind: "fail", error: String(cause), failure: { cause: "inference_error", attempts: 0 } })))
  }
})
