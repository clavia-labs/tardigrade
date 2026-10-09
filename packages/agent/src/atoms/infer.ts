import { atom, type ActService, effectAtom, eventValue, cancel, effectKey, type Atom, type ActorOutput, type EventValue, type Getter } from "@clavia/tardigrade-core"
import { Effect, Schema } from "effect"
import { Atom as NativeAtom } from "effect/unstable/reactivity"
import { type Conversation, Event, TurnRequested, ModelCalled, ModelFailed, ModelReturned, OutputRejected, ToolReturned, TurnSettled } from "../contracts/events"
import { ModelInfo } from "../actor/context"
import { Generate, requests, failureMessage } from "../contracts/acts"
import type { OutputContract } from "../contracts/acts"
import { inferenceState } from "./durable/inference"
import { toolSpend, tokenSpend, usdSpend, timeSpend } from "./durable/spend"
import { type ToolView } from "./tools"

export type ContextView = ActorOutput<{ readonly position: "compacting" } | { readonly position: "failed"; readonly reason: string } | {
  readonly position: "ready"; readonly messages: typeof Conversation.Type
}, Event, ActService<"agent.model.generate"> | ActService<"agent.model.summarize">>
export interface AgentInput<R, ToolEvents extends object = Event> {
  readonly system: string
  readonly tools: ActorOutput<Pick<ToolView<R>, "specs">, ToolEvents, R>
  readonly context: ContextView
  // note is sent after the context as a final user message and is not recorded in the trajectory. Text that changes between calls of one turn belongs here, so the system block stays a stable cache prefix.
  readonly note?: string
  readonly output?: OutputContract
}

export function infer<R, ToolEvents extends object = Event>(agent: Atom<AgentInput<R, ToolEvents>> | ((get: Getter) => AgentInput<R, ToolEvents>)) {
  const agentAtom = typeof agent === "function" ? atom(agent) : agent
  const request = requests(Generate.request, { latestOnly: true })

  const output = Effect.map(ModelInfo, selection => effectAtom(get => {
    get(toolSpend)
    get(tokenSpend)
    get(usdSpend)
    get(timeSpend)
    const input = get(agentAtom)
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
        return !Schema.is(TurnRequested)(event) || !event.promiseRef || !cancelled.has(effectKey(event.promiseRef))
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
    const rejection = turn?.rejection
    const correctionSystem = rejection === null || rejection === undefined || rejection.attempt >= rejection.maxCorrections ? "" :
      `\n\nYour previous response did not satisfy the declared output contract "${rejection.contract}".\nValidation errors:\n${rejection.errors.map(error => `- ${error}`).join("\n")}\nReturn only a corrected response matching the contract.`

    return {
      view: { position: "ready" as const },
      events: proposals.events,
      acts: {
        ...proposals.acts,
        inference: request(state.callId, {
          ...(state.origin === null ? {} : { origin: state.origin }),
          input: { model: selection.model, system: `${input.system}${correctionSystem}`, tools: input.tools.view.specs, context: input.note ? [...messages, { role: "user" as const, text: input.note }] : messages, ...(input.output === undefined ? {} : { output: input.output }) },
          onRequested: () => [{ type: "ModelCalled", purpose: "inference", ...selection, callId: state.callId, turnId: state.turnId } satisfies ModelCalled],
          onSettled: (result, ref) => {
            if (result.status === "rejected") return [{ type: "ModelFailed", callId: state.callId, reason: failureMessage(result.reason) } satisfies typeof ModelFailed.Type]
            if (result.value.outputErrors !== undefined) return [{ type: "OutputRejected", turnId: state.turnId, callId: state.callId, contract: input.output?.name ?? "output", text: result.value.text, errors: result.value.outputErrors, attempt: turn?.calls.length ?? 0, maxCorrections: input.output?.correction?.attempts ?? 0 } satisfies typeof OutputRejected.Type]
            if (new Set(result.value.toolCalls.map(call => call.callId)).size !== result.value.toolCalls.length) return [{ type: "ModelFailed", callId: state.callId, reason: "Duplicate provider tool call IDs" } satisfies typeof ModelFailed.Type]
            return [{ type: "ModelReturned", purpose: "inference", callId: state.callId, text: result.value.text, ...(result.value.reasoning === undefined ? {} : { reasoning: result.value.reasoning }), ...(result.value.continuation === undefined ? {} : { continuation: result.value.continuation }), ...(result.value.usage ? { usage: result.value.usage } : {}),
              toolCalls: result.value.toolCalls.map((call, index) => ({ ...call, providerId: call.callId, callId: JSON.stringify([ref.seq, ref.atom, ref.act, index]) })),
            } satisfies ModelReturned]
          },
        }),
      },
    }
  }))
  return Effect.map(output, node => {
    type Output = typeof node extends Atom<infer Value> ? Value : never
    const typed: Atom<Omit<Output, "events"> & { readonly events: Readonly<Record<string, EventValue<Event | ToolEvents>>> }> = node
    return typed.pipe(NativeAtom.withLabel("infer"))
  })
}
