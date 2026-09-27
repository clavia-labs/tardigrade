import { Cause, Effect, Exit, Schema } from "effect"
import { Atom as NativeAtom } from "effect/unstable/reactivity"
import { runtimeAtom, durablePromise, EffectExecution, eventValue, type Atom, type Getter, durableAtom, effectValue, type EffectValues, type EffectValue } from "@clavia/tardigrade-experimental-core"
import { InferenceState, inferState, initialInference, type Conversation } from "../projections"
import { ModelLock, resolveModel } from "../services/model-lock"
import { Model } from "../services/model"
import type { Tools } from "./tools"
import { Event, ModelSubmitted, ModelReply, type ModelCalled, type ModelReturned, type TurnSettled } from "../event"

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

  const submission = durableAtom({
    schema: Schema.NullOr(ModelSubmitted),
    initial: null,
    reduce: (state, event: Event) => event.type === "ModelSubmitted" ? event
      : event.type === "ModelReturned" && event.purpose === "inference" || event.type === "TurnSettled" ? null : state,
  })
  const replies = new Map<string, ReturnType<typeof makeReply>>()
  const makeReply = (ref: typeof ModelSubmitted.Type["ref"]) => durablePromise(ref, { success: ModelReply, error: Schema.String })

  const output = runtimeAtom(get => {
    const input = get(agent)
    const state = get(inferenceState)
    const submitted = get(submission)

    return Effect.gen(function* () {
      const selection = yield* resolveModel
      const effects: EffectValues<Event, Error, R | Model | ModelLock | EffectExecution> = {
        ...(input.context.effect ? { compact: input.context.effect } : {}),
        ...input.tools.effects,
      }
      if (state.running) {
        if (submitted?.callId === state.callId) {
          const id = JSON.stringify(submitted.ref)
          let promise = replies.get(id)
          if (!promise) { promise = makeReply(submitted.ref); replies.set(id, promise) }
          const settled = get(promise.state)
          if (settled.status !== "pending") {
            const event: ModelReturned | TurnSettled = settled.status === "rejected"
              ? { type: "TurnSettled", turnId: state.turnId, outcome: "failed", reason: settled.error }
              : { type: "ModelReturned", purpose: "inference", callId: state.callId, text: settled.value.text,
                  toolCalls: settled.value.toolCalls.map((call, index) => ({ ...call, callId: `${state.callId}:tool:${index}` })) }
            return { position: "settling" as const, effects: { ...effects, inference: eventValue({ id: `deliver:${state.callId}`, event }) } }
          }
        }
        return { position: "running" as const, effects }
      }
      if (state.turnId && !state.needsReply) return {
        position: "settling" as const,
        effects: { ...effects, inference: eventValue({
          id: `settle:${state.turnId}`,
          event: { type: "TurnSettled", turnId: state.turnId, outcome: "completed", output: state.turns.find(turn => turn.turnId === state.turnId)!.answer! } satisfies TurnSettled,
        }) },
      }
      if (!state.needsReply) return { position: "idle" as const, effects }
      if (state.waiting || input.context.position !== "ready") return { position: "waiting" as const, effects }
      const messages = input.context.messages

      return {
        position: "ready" as const,
        effects: {
          ...effects,
          inference: effectValue<ModelCalled, typeof ModelSubmitted.Type | TurnSettled, never, Model | ModelLock | EffectExecution>({
            id: state.callId,
            request: { type: "ModelCalled" as const, purpose: "inference" as const, ...selection, callId: state.callId, turnId: state.turnId } satisfies ModelCalled,
            run: Effect.gen(function* () {
              const execution = yield* EffectExecution
              const promise = makeReply(execution.ref)
              const model = yield* Model
              const request = { model: selection.model, system: input.system, tools: input.tools.specs, context: messages }
              const handle = yield* (model.submit ? model.submit(request) : execution.fork(
                model.call(request).pipe(
                  Effect.exit,
                  Effect.map(exit => Exit.isSuccess(exit) ? promise.succeed(exit.value) : promise.fail(Cause.pretty(exit.cause))),
                ),
              ))
              return { type: "ModelSubmitted", callId: state.callId, ref: promise.ref, handle } satisfies typeof ModelSubmitted.Type
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
