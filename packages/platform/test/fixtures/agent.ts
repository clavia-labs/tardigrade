import { Context, Effect, Layer, Stream, Schema } from "effect"
import { AiError, LanguageModel, Prompt, Response } from "effect/unstable/ai"
import { atom, createEventLog, type EffectCheckpoint, type EffectExecution, type Recorded } from "@clavia/tardigrade-core"
import { compact } from "@clavia/tardigrade-agent/atoms/compact"
import { infer } from "@clavia/tardigrade-agent/atoms/infer"
import { messages } from "@clavia/tardigrade-agent/atoms/durable/trajectory"
import { ModelInfo } from "@clavia/tardigrade-agent/actor/context"
import { Event } from "@clavia/tardigrade-agent/contracts/events"
import { modelActs, modelInfo, modelServices } from "@clavia/tardigrade-agent/services/model"
import { toolActs } from "@clavia/tardigrade-agent/services/tools"
import { AskPermission } from "@clavia/tardigrade-agent/contracts/acts"
import { ModelLock, modelLockOf, modelLockService } from "@clavia/tardigrade-model/lock"
import { BindingSettings, ModelSelection } from "@clavia/tardigrade-model/settings"
import { type RequestOptions } from "@clavia/tardigrade-model/stream/request"
import { requestPolicyOf } from "@clavia/tardigrade-model/stream/request"
import type { LibraryImplementation } from "@clavia/tardigrade-libraries"

export const selection = { model: { provider: "test", model_id: "test" }, contextWindowTokens: 2_000 }

const agentProjection = Effect.gen(function* () {
  const context = yield* compact(messages)
  return yield* infer(atom(get => ({ system: "Test", tools: { view: { specs: [] }, events: {}, acts: {} }, context: get(context) })))
})

export function agentLog(contextWindowTokens: number, checkpoint?: EffectCheckpoint, context: Context.Context<ModelInfo> = Context.make(ModelInfo, { ...selection, contextWindowTokens }), history?: readonly Recorded<Event>[]) {
  const agent = Effect.runSync(agentProjection.pipe(Effect.provide(context)))
  return createEventLog({ schema: Event, atoms: { agent }, ...(checkpoint === undefined ? {} : { checkpoint }), ...(history === undefined ? {} : { readBefore: (position: number) => history.slice(0, position) }) })
}

type AgentLog = ReturnType<typeof agentLog>
type Snapshot = ReturnType<AgentLog["replay"]>
export function turn(log: AgentLog, snapshot: Snapshot, turnId: string, text: string) {
  snapshot = log.append(snapshot, { type: "TurnRequested", turnId, text })
  for (let step = 0; step < 10; step++) {
    const work = snapshot.effects().find(work => !work.ref)
    if (work) {
      const ref = { seq: snapshot.position, atom: work.atom, act: work.request.act }
      const request = log.requestEvent(ref, work.request, work.origin)
      snapshot = log.append(snapshot, request)
      const settled = { type: "EffectSettled" as const, ref, outcome: { status: "fulfilled" as const, value: { type: "value", value: { text: work.request.act === "agent.model.summarize" ? "Summary" : "Answer", toolCalls: [] } } } }
      snapshot = log.append(snapshot, settled)
      continue
    }
    const proposal = Object.values(snapshot.view().agent.events)[0]
    if (!proposal) return snapshot
    snapshot = log.append(snapshot, proposal.event)
  }
  throw new Error("Agent turn did not settle")
}


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
