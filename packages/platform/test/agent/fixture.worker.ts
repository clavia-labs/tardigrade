import { Layer, Effect, Stream } from "effect"
import { LanguageModel, Prompt, Response } from "effect/unstable/ai"
import { actorContext, createActor } from "@clavia/tardigrade-agent"
import { modelActs, modelInfo, modelServices } from "@clavia/tardigrade-agent/services/model"
import { toolActs } from "@clavia/tardigrade-agent/services/tools"
import { AskPermission } from "@clavia/tardigrade-agent/contracts/acts"
import { ModelLock, modelLockOf, modelLockService } from "@clavia/tardigrade-model/lock"
import { BindingSettings, ModelSelection } from "@clavia/tardigrade-model/settings"
import { requestPolicyOf } from "@clavia/tardigrade-model/stream/request"
import { objectStorageFromR2 } from "@clavia/tardigrade-cloudflare/object-storage/r2"
import { createActorWorker } from "../../src/cloudflare"

export interface AgentEnv {
  readonly ACTORS: DurableObjectNamespace
  readonly THREADS: DurableObjectNamespace
  readonly OBJECTS: R2Bucket
}

export let observedPrompt: Prompt.Prompt | undefined
let providerCalls = 0
export const providerCallCount = () => providerCalls

const model = { provider: "fixture", model_id: "test" }
const binding = { provider: "fixture", protocol: "openai-chat-completions", model: "test", endpoint: "https://fixture.invalid", policy: requestPolicyOf({}) }
const lock = modelLockService(modelLockOf({
  schema: 2,
  providers: { fixture: { protocol: "openai-chat-completions", baseUrl: "https://fixture.invalid", env: [] } },
  models: [{ provider: "fixture", model_id: "test", contextWindowTokens: 4096 }],
}), { allow: "*", default: model })
const provider = Layer.effect(LanguageModel.LanguageModel, LanguageModel.make({
  generateText: input => Effect.sync(() => { providerCalls++; observedPrompt = Prompt.isPrompt(input.prompt) ? input.prompt : Prompt.fromMessages([]); return [Response.makePart("text", { text: "ok" })] }),
  streamText: input => {
    providerCalls++
    observedPrompt = input.prompt
    return Stream.make(
      Response.makePart("text-start", { id: "reply" }),
      Response.makePart("text-delta", { id: "reply", delta: "ok" }),
      Response.makePart("text-end", { id: "reply" }),
      Response.makePart("finish", { reason: "stop", usage: Response.Usage.make({ inputTokens: {}, outputTokens: {} }) }),
    )
  },
}))
const modelLayer = modelServices().pipe(Layer.provide(Layer.mergeAll(
  Layer.succeed(ModelLock, lock), provider,
  Layer.succeed(ModelSelection, { settings: () => Effect.succeed(binding) }),
  Layer.succeed(BindingSettings, binding),
)))
const lockLayer = Layer.succeed(ModelLock, lock)

const worker = createActorWorker<AgentEnv>({
  actor: createActor as any,
  actorContext,
  services: (env, _coordinate, _runtime, storage) => Layer.mergeAll(
    lockLayer,
    modelInfo.pipe(Layer.provide(lockLayer)),
    modelActs.pipe(Layer.provide(modelLayer)),
    toolActs([]),
    AskPermission.layer(() => Effect.die("No tool permission should be requested")),
    modelLayer,
    objectStorageFromR2(env.OBJECTS, { cache: { storage, bucketNamespace: "agent-content" } }),
  ),
})

export const AgentActorDO = worker.ActorObject
export const AgentThreadDO = worker.ThreadObject
export default worker
