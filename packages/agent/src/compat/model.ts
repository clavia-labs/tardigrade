import { Context, Effect, Option, Schema } from "effect"
import { atom, AtomState, ReplayContext, RuntimeError } from "@clavia/tardigrade-core"
import { EventLog, eventLogContext } from "@clavia/tardigrade-core/services/event-log"
import { ModelCalled, ModelConfigured, ModelConfiguration } from "../contracts/events"
import { modelState } from "../atoms/durable/model"

// prepareModel indexes old calls when the loading boundary lacks durable model configuration.
const prepareModel = (replay: typeof ReplayContext.Service) => Effect.gen(function* () {
  const configured = replay.checkpoint?.durable.find(entry => entry.name === modelState[AtomState].name)
  if (configured && (configured.reference !== undefined || Schema.is(ModelConfiguration)(configured.state))) return undefined
  const records = replay.checkpoint ? yield* replay.readFull : replay.records
  const configuredAt = records.findIndex(({ event }) => Schema.is(ModelConfigured)(event))
  const end = configuredAt < 0 ? records.length : configuredAt
  const calls = records.slice(0, end).flatMap(({ event }, position) => Schema.is(ModelCalled)(event) ? [{ position, model: event.model, contextWindowTokens: event.contextWindowTokens }] : [])
  return { end, calls }
})

// modelSelection prefers logged configuration and reconstructs metadata for an unconfigured prefix.
export const modelSelection = Effect.gen(function* () {
  const replay = yield* Effect.serviceOption(ReplayContext)
  const plan = Option.isSome(replay) ? yield* prepareModel(replay.value) : undefined
  return atom(get => {
    const configuredModel = get(modelState).read([])
    if (configuredModel || !plan) return configuredModel ?? undefined
    const context = get(eventLogContext)
    if (!context) throw new RuntimeError("Missing EventLog service")
    const service = Context.get(context, EventLog)
    const configured = service.position
    const position = ((typeof configured === "function" ? configured() : configured) ?? 0) + get(service.events).length
    if (position >= plan.end) return undefined
    let low = 0
    let high = plan.calls.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (plan.calls[middle]!.position < position) low = middle + 1
      else high = middle
    }
    const call = plan.calls[low] ?? plan.calls.at(-1)
    return call && { model: call.model, contextWindowTokens: call.contextWindowTokens }
  })
})
