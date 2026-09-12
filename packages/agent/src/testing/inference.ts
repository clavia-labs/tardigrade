import { Cause, Effect, Layer, Schema, Stream } from "effect"
import { AiError, LanguageModel, Response } from "effect/unstable/ai"
import type { InferRequest, ModelResolution } from "../inference/contract"
import type { InferDelta } from "../inference/observer"
import type { Action } from "../log/events"
import type { LegacyCallAction } from "../inference/action-compat"
import { normalizeAction } from "../inference/action-compat"
import { upcastUsage } from "../log/response-upcast"
import { unknownModelError } from "../inference/error"
import type { RequestPolicy } from "../inference/retry"
import type { ModelRef } from "../inference/reference"
import type { ModelPricing } from "../inference/usage"
import { BindingInvocation, BindingSettings, ModelSelection } from "../binding/settings"
import { react } from "../binding/index"

export interface TestInference {
  readonly output?: import("../binding/output").OutputCapability
  readonly resolve?: (model?: ModelRef) => ModelResolution
  readonly policy?: (model?: ModelRef) => Effect.Effect<RequestPolicy | undefined>
  readonly pricing?: (model?: ModelRef) => Effect.Effect<ModelPricing | undefined>
  readonly react: (request: InferRequest, key?: string, signal?: AbortSignal, onDelta?: (delta: InferDelta) => void) => Effect.Effect<Action | LegacyCallAction>
}

// inferenceClient captures an Effect model for direct binding tests.
export const inferenceClient = Effect.gen(function* () {
  const context = yield* Effect.context<LanguageModel.LanguageModel>()
  const settings = yield* BindingSettings
  const registry = yield* ModelSelection
  return {
    layer: Layer.succeedContext(context),
    resolve: registry.resolve ?? (() => ({ model: { provider: settings.provider, model_id: settings.model } })),
    policy: () => Effect.succeed(settings.policy),
    pricing: () => Effect.succeed(settings.pricing),
    react: (...args: Parameters<typeof react>) => Effect.gen(function* () {
      const current = yield* (registry.settings?.(args[0].model) ?? Effect.succeed(settings))
      return yield* react(...args).pipe(Effect.provideService(BindingSettings, current))
    }).pipe(Effect.provide(context), Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.succeed<Action>({ kind: "fail", error: String(cause), failure: { cause: "inference_error", attempts: 0 } })))
  }
})

// testInferenceLayer translates scripted outcomes into native model parts for runtime fixtures.
export const testInferenceLayer = (script: TestInference): Layer.Layer<LanguageModel.LanguageModel> => {
  const selection = Layer.succeed(ModelSelection, {
    ...(script.resolve === undefined ? {} : { resolve: script.resolve }),
    settings: (model?: ModelRef) => Effect.gen(function* () {
      const defaults = yield* BindingSettings
      const policy = yield* (script.policy?.(model) ?? Effect.succeed(undefined))
      const pricing = yield* (script.pricing?.(model) ?? Effect.succeed(undefined))
      return { ...defaults, ...(script.output === undefined ? {} : { output: script.output }), ...(model === undefined ? {} : { provider: model.provider, model: model.model_id }), ...(policy === undefined ? {} : { policy }), ...(pricing === undefined ? {} : { pricing }), reportedCostUsd: (part: Response.FinishPart) => {
        const metadata = part.metadata.fixture
        const value = Schema.is(Schema.Record(Schema.String, Schema.Json))(metadata) ? metadata.reportedCostUsd : undefined
        return typeof value === "number" ? value : undefined
      } }
    })
  })
  const model = Layer.succeed(LanguageModel.LanguageModel, {
    [LanguageModel.TypeId]: LanguageModel.TypeId,
    generateText: () => Effect.die("Use streamText in this fixture"),
    generateObject: () => Effect.die("Use streamText in this fixture"),
    streamText: () => Stream.unwrap(Effect.gen(function* () {
      const invocation = yield* BindingInvocation
      if (invocation === undefined) return yield* Effect.die("Missing binding invocation")
      const action = normalizeAction(yield* script.react(invocation.request, invocation.key, invocation.signal, invocation.onDelta))
      if (action.kind === "fail") {
        const error = action.retryable === true ? AiError.make({ module: "Fixture", method: "streamText", reason: AiError.RateLimitError.make({}) }) : unknownModelError(action.error)
        return Stream.concat(Stream.make(Response.makePart("finish", { reason: "error", usage: new Response.Usage(upcastUsage(action.usage)) })), Stream.fail(error))
      }
      const text = action.kind === "complete" ? action.output : action.text ?? ""
      const parts: Response.AnyPart[] = []
      const legacyUsage = action.usage as import("../inference/usage").Usage | undefined
      if (legacyUsage?.model !== undefined) parts.push(Response.makePart("response-metadata", { modelId: legacyUsage.model }))
      if (text !== "") parts.push(Response.makePart("text-start", { id: "text" }), Response.makePart("text-delta", { id: "text", delta: text }), Response.makePart("text-end", { id: "text" }))
      if (action.kind === "calls") for (const call of action.calls) parts.push(Response.makePart("tool-call", { id: call.callId, name: call.name, params: call.arguments, providerExecuted: false }))
      const cost = action.reportedCostUsd ?? legacyUsage?.costUsd
      parts.push(Response.makePart("finish", { reason: action.kind === "calls" ? "tool-calls" : "stop", usage: new Response.Usage(upcastUsage(action.usage)), ...(cost === undefined ? {} : { metadata: { fixture: { reportedCostUsd: cost } } }) }))
      return Stream.fromIterable(parts)
    }))
  } as typeof LanguageModel.LanguageModel.Service)
  return Layer.merge(selection, model)
}
