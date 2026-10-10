import { Layer, Effect, Stream, Schema } from "effect"
import { AiError, LanguageModel, Prompt, Response } from "effect/unstable/ai"
import { modelActs, modelInfo, modelServices } from "@clavia/tardigrade-agent/services/model"
import { toolActs } from "@clavia/tardigrade-agent/services/tools"
import { AskPermission } from "@clavia/tardigrade-agent/contracts/acts"
import { ModelLock, modelLockOf, modelLockService } from "@clavia/tardigrade-model/lock"
import { BindingSettings, ModelSelection } from "@clavia/tardigrade-model/settings"
import { type RequestOptions } from "@clavia/tardigrade-model/stream/request"
import { requestPolicyOf } from "@clavia/tardigrade-model/stream/request"
import type { LibraryImplementation } from "@clavia/tardigrade-libraries"
import type { EffectExecution } from "@clavia/tardigrade-core"

const model = { provider: "fixture", model_id: "test" }
const binding = { provider: "fixture", protocol: "openai-chat-completions", model: "test", endpoint: "https://fixture.invalid", policy: requestPolicyOf({}) }
const lock = modelLockService(modelLockOf({
  schema: 2,
  providers: { fixture: { protocol: "openai-chat-completions", baseUrl: "https://fixture.invalid", env: [] } },
  models: [{ provider: "fixture", model_id: "test", contextWindowTokens: 4096 }],
}), { allow: "*", default: model })
export const contentServices = (observe: (prompt: Prompt.Prompt) => void, options: {
  readonly failure?: (prompt: Prompt.Prompt) => AiError.AiError | undefined
  readonly request?: RequestOptions
  readonly libraries?: readonly LibraryImplementation<EffectExecution>[]
  readonly toolCalls?: readonly { readonly id: string; readonly name: string; readonly params: Schema.Json }[]
} = {}) => {
  const settings = { ...binding, policy: requestPolicyOf(options.request ?? {}) }
  const provider = Layer.effect(LanguageModel.LanguageModel, LanguageModel.make({
    generateText: input => Effect.suspend(() => { observe(input.prompt); const failure = options.failure?.(input.prompt); return failure ? Effect.fail(failure) : Effect.succeed([Response.makePart("text", { text: "ok" })]) }),
    streamText: input => Stream.suspend((): Stream.Stream<Response.StreamPartEncoded, AiError.AiError> => {
      observe(input.prompt)
      const failure = options.failure?.(input.prompt)
      if (failure) return Stream.fail(failure)
      if (options.toolCalls && !input.prompt.content.some(message => message.role === "tool")) return Stream.fromIterable([
        ...options.toolCalls.map(call => Response.makePart("tool-call", { ...call, providerExecuted: false })),
        Response.makePart("finish", { reason: "tool-calls", usage: Response.Usage.make({ inputTokens: {}, outputTokens: {} }) }),
      ])
      return Stream.make(
        Response.makePart("text-start", { id: "reply" }),
        Response.makePart("text-delta", { id: "reply", delta: "ok" }),
        Response.makePart("text-end", { id: "reply" }),
        Response.makePart("finish", { reason: "stop", usage: Response.Usage.make({ inputTokens: {}, outputTokens: {} }) }),
      )
    }),
  }))
  const modelLayer = modelServices().pipe(Layer.provide(Layer.mergeAll(
    Layer.succeed(ModelLock, lock), provider,
    Layer.succeed(ModelSelection, { settings: () => Effect.succeed(settings) }),
    Layer.succeed(BindingSettings, settings),
  )))
  const lockLayer = Layer.succeed(ModelLock, lock)

  return Layer.mergeAll(
    modelInfo.pipe(Layer.provide(lockLayer)),
    modelActs.pipe(Layer.provide(modelLayer)),
    toolActs(options.libraries ?? []),
    AskPermission.layer(() => options.libraries ? Effect.succeed({ allowed: true, reason: "Fixture tool permission" }) : Effect.die("No tool permission should be requested")),
  )
}
