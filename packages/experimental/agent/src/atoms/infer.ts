import { Effect } from "effect"
import { Atom as NativeAtom } from "effect/unstable/reactivity"
import { runtimeAtom, type Atom, type Getter, durableAtom, effectValue, type EffectValues, type EffectValue } from "@clavia/tardigrade-experimental-core"
import { InferenceState, inferState, initialInference, type Conversation } from "../projections"
import { ModelLock, resolveModel } from "../services/model-lock"
import { Model } from "../services/model"
import type { Tools } from "./tools"
import { Event, type ModelCalled, type ModelReturned, type TurnSettled } from "../event"

export type ContextView = ({ readonly position: "compacting" } | {
  readonly position: "ready"; readonly messages: typeof Conversation.Type
}) & { readonly effect?: EffectValue<Event, Error, Model | ModelLock> }
export interface AgentInput<R> {
  readonly system: string
  readonly tools: Tools<R>
  readonly context: ContextView
}

export function infer<R>(agent: Atom<AgentInput<R>>) {
  const inferenceState = durableAtom({
    schema: InferenceState,
    initial: initialInference, reduce: inferState,
  })

  const output = runtimeAtom(get => {
    const input = get(agent)
    const state = get(inferenceState)

    return Effect.gen(function* () {
      const selection = yield* resolveModel
      const effects: EffectValues<Event, Error, R | Model | ModelLock> = {
        ...(input.context.effect ? { compact: input.context.effect } : {}),
        ...input.tools.effects,
      }
      if (state.running) return { position: "running" as const, effects }
      if (state.turnId && !state.needsReply) return { position: "settling" as const, effects }
      if (!state.needsReply) return { position: "idle" as const, effects }
      if (state.waiting || input.context.position !== "ready") return { position: "waiting" as const, effects }
      const messages = input.context.messages

      return {
        position: "ready" as const,
        effects: {
          ...effects,
          inference: effectValue<ModelCalled, ModelReturned | TurnSettled, never, Model | ModelLock>({
            id: state.callId,
            request: { type: "ModelCalled" as const, purpose: "inference" as const, ...selection, callId: state.callId, turnId: state.turnId } satisfies ModelCalled,
            run: Effect.gen(function* () {
              const model = yield* Model
              const reply = yield* model.call({ model: selection.model, system: input.system, tools: input.tools.specs, context: messages })
              const returned = { type: "ModelReturned" as const, purpose: "inference" as const, callId: state.callId, text: reply.text,
                toolCalls: reply.toolCalls.map((call, index) => ({ ...call, callId: `${state.callId}:tool:${index}` })) } satisfies ModelReturned
              return reply.toolCalls.length ? [returned] : [
                returned,
                { type: "TurnSettled", turnId: state.turnId, outcome: "completed", output: reply.text } satisfies TurnSettled,
              ]
            }).pipe(Effect.catch(error => Effect.succeed({
              type: "TurnSettled", turnId: state.turnId, outcome: "failed", reason: String(error),
            } satisfies TurnSettled))),
          }),
        },
      }
    })
  }, { name: "infer" })
  return Effect.map(output, node => Object.assign(node.pipe(NativeAtom.withLabel("infer")), {
    schema: Event,
    validate: (event: Event, get: Getter) => get(agent).tools.validate?.(event),
  }))
}
