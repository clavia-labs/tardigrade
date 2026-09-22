import { ModelLock, emptyModelLock } from "@clavia/tardigrade-model/lock"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { AiError, LanguageModel, Response } from "effect/unstable/ai"
import type { InferRequest, ModelResolution } from "../src/model/contract"
import type { InferDelta } from "../src/model/observer"
import type { Action } from "../src/log/events"
import type { LegacyCallAction } from "../src/model/action-compat"
import { normalizeAction } from "../src/model/action-compat"
import { upcastUsage } from "../src/log/response-upcast"
import { unknownModelError } from "../src/model/error"
import type { RequestPolicy } from "../src/component/infer/retry"
import type { ModelRef } from "../src/model/reference"
import type { ModelPricing } from "../src/model/usage"
import { BindingInvocation, BindingSettings, ModelSelection } from "../src/model/execution/settings"

export interface TestInference {
  readonly output?: import("../src/model/execution/output").OutputCapability
  readonly resolve?: (model?: ModelRef) => ModelResolution
  readonly policy?: (model?: ModelRef) => Effect.Effect<RequestPolicy | undefined>
  readonly pricing?: (model?: ModelRef) => Effect.Effect<ModelPricing | undefined>
  readonly react: (request: InferRequest, key?: string, signal?: AbortSignal, onDelta?: (delta: InferDelta) => void) => Effect.Effect<Action | LegacyCallAction>
}

// testModelLock supplies a pure lookup for scripted model fixtures.
export const testModelLock = (resolve: NonNullable<TestInference["resolve"]> = (model = { provider: "test", model_id: "fixture" }) => {
  return { model, contextWindowTokens: 128_000 }
}): Context.Service.Shape<typeof ModelLock> => ({ definitions: emptyModelLock(), resolve })
export const testModelData = Context.make(ModelLock, testModelLock())
export const testModelLockLayer = Layer.succeed(ModelLock, testModelLock())

// testInferenceLayer translates scripted outcomes into native model parts for runtime fixtures.
export const testInferenceLayer = (script: TestInference): Layer.Layer<LanguageModel.LanguageModel | ModelLock> => {
  const selection = Layer.succeed(ModelSelection, {
    settings: (model?: ModelRef) => Effect.gen(function* () {
      const defaults = yield* BindingSettings
      const policy = yield* (script.policy?.(model) ?? Effect.void)
      const pricing = yield* (script.pricing?.(model) ?? Effect.void)
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
        return Stream.concat(Stream.make(Response.makePart("finish", { reason: "error", usage: Response.Usage.make(upcastUsage(action.usage)) })), Stream.fail(error))
      }
      const text = action.kind === "complete" ? action.output : action.text ?? ""
      const parts: Response.AnyPart[] = []
      const legacyUsage = action.usage as import("../src/model/usage").Usage | undefined
      if (legacyUsage?.model !== undefined) parts.push(Response.makePart("response-metadata", { modelId: legacyUsage.model }))
      if (text !== "") parts.push(Response.makePart("text-start", { id: "text" }), Response.makePart("text-delta", { id: "text", delta: text }), Response.makePart("text-end", { id: "text" }))
      if (action.kind === "calls") for (const call of action.calls) parts.push(Response.makePart("tool-call", { id: call.callId, name: call.name, params: call.arguments, providerExecuted: false }))
      const cost = action.reportedCostUsd ?? legacyUsage?.costUsd
      parts.push(Response.makePart("finish", { reason: action.kind === "calls" ? "tool-calls" : "stop", usage: Response.Usage.make(upcastUsage(action.usage)), ...(cost === undefined ? {} : { metadata: { fixture: { reportedCostUsd: cost } } }) }))
      return Stream.fromIterable(parts)
    }))
  } as typeof LanguageModel.LanguageModel.Service)
  return Layer.mergeAll(selection, model, Layer.succeed(ModelLock, {
    definitions: emptyModelLock(),
    resolve: script.resolve ?? ((model) => {
      if (model === undefined) throw new Error("no model was selected; supply { provider, model_id } or configure a default")
      return { model, contextWindowTokens: 128_000 }
    })
  }))
}
