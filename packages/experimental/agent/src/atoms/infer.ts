import type { ActService } from "@clavia/tardigrade-experimental-core"
import { Effect, Schema } from "effect"
import { Atom as NativeAtom } from "effect/unstable/reactivity"
import { effectAtom, eventValue, cancel, effectKey, type Atom, type Getter, type ActorOutput } from "@clavia/tardigrade-experimental-core"
import { type Conversation } from "../projections"
import { ModelInfo } from "../context"
import { Generate, requests, failureMessage } from "../acts"
import { inferenceState } from "./durable/inference"
import { toolSpend, tokenSpend, usdSpend } from "./durable/spend"
import type { ToolView } from "./tools"
import { Event, MessageReceived, ModelCalled, ModelFailed, ModelReturned, ToolReturned, TurnSettled } from "../event"

export type ContextView = ActorOutput<{ readonly position: "compacting" } | { readonly position: "failed"; readonly reason: string } | {
  readonly position: "ready"; readonly messages: typeof Conversation.Type
}, Event, ActService<"agent.model.generate"> | ActService<"agent.model.summarize">>
export interface AgentInput<R, ToolEvents extends object = Event> {
  readonly system: string
  readonly tools: ActorOutput<Pick<ToolView<R>, "specs" | "validate">, ToolEvents, R>
  readonly context: ContextView
}

export function infer<R, ToolEvents extends object = Event>(agent: Atom<AgentInput<R, ToolEvents>>) {
  const request = requests(Generate.request)

  const output = Effect.map(ModelInfo, selection => effectAtom(get => {
    get(toolSpend)
    get(tokenSpend)
    get(usdSpend)
    const input = get(agent)
    const state = get(inferenceState)
    const turn = state.turns.find(turn => turn.turnId === state.turnId)

    if (turn && turn.cancellation !== null) {
      const reason = turn.cancellation
      const pending = turn.effects.filter(work => work.pending)
      return {
        view: { position: "stopping" as const },
        acts: Object.fromEntries(pending.map(({ ref }) => [encodeURIComponent(effectKey(ref)), cancel(ref, reason)])),
        events: pending.length ? {} : turn.outstanding.length
          ? Object.fromEntries(turn.outstanding.map(callId => [encodeURIComponent(callId), eventValue({ type: "ToolReturned", callId, output: "", error: reason } satisfies ToolReturned)]))
          : { inference: eventValue({ type: "TurnSettled", turnId: turn.turnId, outcome: "cancelled", reason } satisfies TurnSettled) },
      }
    }

    const cancelled = new Set(state.turns.filter(turn => turn.cancellation !== null).flatMap(turn => turn.effects.map(work => effectKey(work.ref))))
    const proposals = {
      events: Object.fromEntries(Object.entries({ ...input.context.events, ...input.tools.events }).filter(([, proposal]) => {
        const event = proposal.event
        return !Schema.is(MessageReceived)(event) || event.kind !== "message" || !event.promiseRef || !cancelled.has(effectKey(event.promiseRef))
      })),
      acts: state.turnId ? { ...input.context.acts, ...input.tools.acts } : {},
    }
    if (state.running) return { view: { position: "running" as const }, ...proposals }
    if (turn && turn.failure !== null) return {
      view: { position: "settling" as const }, acts: proposals.acts,
      events: { ...proposals.events, inference: eventValue({ type: "TurnSettled", turnId: turn.turnId, outcome: "failed", reason: turn.failure } satisfies TurnSettled) },
    }
    if (state.turnId && !state.needsReply) return {
      view: { position: "settling" as const },
      acts: proposals.acts,
      events: { ...proposals.events, inference: eventValue({ type: "TurnSettled", turnId: state.turnId, outcome: "completed", callId: state.turns.find(turn => turn.turnId === state.turnId)!.answerCallId! } satisfies TurnSettled) },
    }
    if (!state.needsReply) return { view: { position: "idle" as const }, ...proposals }
    if (!state.waiting && input.context.view.position === "failed") return {
      view: { position: "settling" as const },
      acts: proposals.acts,
      events: { ...proposals.events, inference: eventValue({ type: "TurnSettled", turnId: state.turnId, outcome: "failed", reason: input.context.view.reason } satisfies TurnSettled) },
    }
    if (state.waiting || input.context.view.position !== "ready") return { view: { position: "waiting" as const }, ...proposals }
    const messages = input.context.view.messages

    return {
      view: { position: "ready" as const },
      events: proposals.events,
      acts: {
        ...proposals.acts,
        inference: request({
          tag: state.callId,
          input: { model: selection.model, system: input.system, tools: input.tools.view.specs, context: messages },
          onRequested: () => [{ type: "ModelCalled", purpose: "inference", ...selection, callId: state.callId, turnId: state.turnId } satisfies ModelCalled],
          onSettled: (result, ref) => {
            if (result.status === "rejected") return [{ type: "ModelFailed", callId: state.callId, reason: failureMessage(result.reason) } satisfies typeof ModelFailed.Type]
            if (new Set(result.value.toolCalls.map(call => call.callId)).size !== result.value.toolCalls.length) return [{ type: "ModelFailed", callId: state.callId, reason: "Duplicate provider tool call IDs" } satisfies typeof ModelFailed.Type]
            return [{ type: "ModelReturned", purpose: "inference", callId: state.callId, text: result.value.text, ...(result.value.usage ? { usage: result.value.usage } : {}),
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
