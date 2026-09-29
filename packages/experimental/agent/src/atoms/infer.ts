import type { ActService } from "@clavia/tardigrade-experimental-core"
import { durableAtom } from "@clavia/tardigrade-experimental-core"
import { Effect, Schema } from "effect"
import { Atom as NativeAtom } from "effect/unstable/reactivity"
import { effectAtom, eventValue, type Atom, type Getter, type EffectValues, type EffectOutput } from "@clavia/tardigrade-experimental-core"
import { InferenceState, inferState, initialInference, type Conversation } from "../projections"
import { ModelInfo } from "../context"
import { Generate, requests } from "../acts"
import type { Tools } from "./tools"
import { Event, ModelCalled, MessageReceived, ToolReturned, ModelReturned, TurnSettled } from "../event"

export type ContextView = EffectOutput<{ readonly position: "compacting" } | { readonly position: "failed"; readonly reason: string } | {
  readonly position: "ready"; readonly messages: typeof Conversation.Type
}, Event, ActService<"agent.model.generate"> | ActService<"agent.model.summarize">>
export interface AgentInput<R> {
  readonly system: string
  readonly tools: Tools<R>
  readonly context: ContextView
}

export function infer<R>(agent: Atom<AgentInput<R>>) {
  const inferenceState = durableAtom({ input: Schema.Union([MessageReceived, ModelCalled, ModelReturned, ToolReturned, TurnSettled]),
    schema: InferenceState,
    initial: initialInference, reduce: inferState,
  })

  const request = requests(Generate.request)

  const output = Effect.map(ModelInfo, selection => effectAtom(get => {
    const input = get(agent)
    const state = get(inferenceState)

    const effects: EffectValues<Event, R | ActService<"agent.model.generate"> | ActService<"agent.model.summarize">> = {
      ...input.context.effects,
      ...input.tools.effects,
    }
    if (state.running) return { view: { position: "running" as const }, effects }
    if (state.turnId && !state.needsReply) return {
      view: { position: "settling" as const },
      effects: { ...effects, inference: eventValue({ type: "TurnSettled", turnId: state.turnId, outcome: "completed", callId: state.turns.find(turn => turn.turnId === state.turnId)!.answerCallId! } satisfies TurnSettled) },
    }
    if (!state.needsReply) return { view: { position: "idle" as const }, effects }
    if (!state.waiting && input.context.view.position === "failed") return {
      view: { position: "settling" as const },
      effects: { ...effects, inference: eventValue({ type: "TurnSettled", turnId: state.turnId, outcome: "failed", reason: input.context.view.reason } satisfies TurnSettled) },
    }
    if (state.waiting || input.context.view.position !== "ready") return { view: { position: "waiting" as const }, effects }
    const messages = input.context.view.messages

    return {
      view: { position: "ready" as const },
      effects: {
        ...effects,
        inference: request({
          tag: state.callId,
          input: { model: selection.model, system: input.system, tools: input.tools.view.specs, context: messages },
          onRequested: () => [{ type: "ModelCalled", purpose: "inference", ...selection, callId: state.callId, turnId: state.turnId } satisfies ModelCalled],
          onSettled: (result, ref) => {
            if (result.status === "rejected") return [{ type: "TurnSettled", turnId: state.turnId, outcome: "failed", reason: result.reason } satisfies TurnSettled]
            if (new Set(result.value.toolCalls.map(call => call.callId)).size !== result.value.toolCalls.length) return [{ type: "TurnSettled", turnId: state.turnId, outcome: "failed", reason: "Duplicate provider tool call IDs" } satisfies TurnSettled]
            return [{ type: "ModelReturned", purpose: "inference", callId: state.callId, text: result.value.text,
              toolCalls: result.value.toolCalls.map((call, index) => ({ ...call, providerId: call.callId, callId: JSON.stringify([ref.seq, ref.atom, ref.tag, index]) })),
            } satisfies ModelReturned]
          },
        }),
      },
    }
  }))
  return Effect.map(output, node => Object.assign(node.pipe(NativeAtom.withLabel("infer")), {
    schema: Event,
    validate: (event: Event, get: Getter) => get(agent).tools.view.validate?.(event),
  }))
}
