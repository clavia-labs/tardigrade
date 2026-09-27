import { settledProjection } from "./settled-projection"
import { Cause, Effect, Exit, Schema } from "effect"
import { Atom as NativeAtom } from "effect/unstable/reactivity"
import { effectAtom, durablePromise, EffectExecution, eventValue, type Atom, type Getter, durableAtom, effectValue, type EffectValues, type EffectOutput } from "@clavia/tardigrade-experimental-core"
import { InferenceState, inferState, initialInference, type Conversation } from "../projections"
import { ModelLock, resolveModel } from "../services/model-lock"
import { Model } from "../services/model"
import type { Tools } from "./tools"
import { Event, ModelPromiseReturned, ModelReply, ModelCalled, MessageReceived, ToolReturned, ModelReturned, TurnSettled } from "../event"

export type ContextView = EffectOutput<{ readonly position: "compacting" } | {
  readonly position: "ready"; readonly messages: typeof Conversation.Type
}, Event, Error, Model | ModelLock>
export interface AgentInput<R> {
  readonly system: string
  readonly tools: Tools<R>
  readonly context: ContextView
}

export function infer<R>(agent: Atom<AgentInput<R>>) {
  const inferenceState = settledProjection({ input: Schema.Union([MessageReceived, ModelCalled, ModelReturned, ToolReturned, TurnSettled]),
    schema: InferenceState,
    initial: initialInference, reduce: inferState,
  })

  const submission = durableAtom({
    input: Schema.Union([ModelReturned, TurnSettled]),
    schema: Schema.NullOr(ModelPromiseReturned),
    initial: null,
    reduce: (state, event: Event) => event.type === "ModelReturned" && "promise" in event ? event
      : event.type === "ModelReturned" && event.purpose === "inference" || event.type === "TurnSettled" ? null : state,
  })
  const replies = new Map<string, ReturnType<typeof makeReply>>()
  const makeReply = (ref: typeof ModelPromiseReturned.Type["promise"]["ref"]) => durablePromise(ref, { success: ModelReply, error: Schema.String })

  const output = Effect.map(resolveModel, selection => effectAtom(get => {
    const input = get(agent)
    const state = get(inferenceState)
    const submitted = get(submission)

    const effects: EffectValues<Event, Error, R | Model | ModelLock | EffectExecution> = {
      ...input.context.effects,
      ...input.tools.effects,
    }
    if (state.running) {
      if (submitted?.callId === state.callId) {
        const id = JSON.stringify(submitted.promise.ref)
        let promise = replies.get(id)
        if (!promise) { promise = makeReply(submitted.promise.ref); replies.set(id, promise) }
        const settled = get(promise.state)
        if (settled.status === "rejected") {
          const event: TurnSettled = { type: "TurnSettled", turnId: state.turnId, outcome: "failed", reason: settled.error }
          return { view: { position: "settling" as const }, effects: { ...effects, inference: eventValue({ id: `deliver:${state.callId}`, event }) } }
        }
      }
      return { view: { position: "running" as const }, effects }
    }
    if (state.turnId && !state.needsReply) return {
      view: { position: "settling" as const },
      effects: { ...effects, inference: eventValue({
        id: `settle:${state.turnId}`,
        event: { type: "TurnSettled", turnId: state.turnId, outcome: "completed", output: state.turns.find(turn => turn.turnId === state.turnId)!.answer! } satisfies TurnSettled,
      }) },
    }
    if (!state.needsReply) return { view: { position: "idle" as const }, effects }
    if (state.waiting || input.context.view.position !== "ready") return { view: { position: "waiting" as const }, effects }
    const messages = input.context.view.messages

    return {
      view: { position: "ready" as const },
      effects: {
        ...effects,
        inference: effectValue<ModelCalled, typeof ModelPromiseReturned.Type | TurnSettled, never, Model | ModelLock | EffectExecution>({
          id: state.callId,
          request: { type: "ModelCalled" as const, purpose: "inference" as const, ...selection, callId: state.callId, turnId: state.turnId } satisfies ModelCalled,
          run: Effect.gen(function* () {
            const execution = yield* EffectExecution
            const promise = makeReply(execution.ref)
            const model = yield* Model
            const request = { model: selection.model, system: input.system, tools: input.tools.view.specs, context: messages }
            const handle = yield* (model.submit ? model.submit(request) : execution.fork(
              model.call(request).pipe(
                Effect.exit,
                Effect.map(exit => Exit.isSuccess(exit) ? promise.succeed(exit.value) : promise.fail(Cause.pretty(exit.cause))),
              ),
            ))
            return { type: "ModelReturned", purpose: "inference", callId: state.callId, promise: { type: "promise", ref: promise.ref, handle } } satisfies typeof ModelPromiseReturned.Type
          }).pipe(Effect.catch(error => Effect.succeed({
            type: "TurnSettled", turnId: state.turnId, outcome: "failed", reason: String(error),
          } satisfies TurnSettled))),
        }),
      },
    }
  }))
  return Effect.map(output, node => Object.assign(node.pipe(NativeAtom.withLabel("infer")), {
    schema: Event,
    validate: (event: Event, get: Getter) => get(agent).tools.view.validate?.(event),
  }))
}
