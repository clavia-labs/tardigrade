import { turnView } from "@clavia/tardigrade-code/execution/turns"
import type { Event } from "@clavia/tardigrade-core/event"
import { modelRefOf, type ModelRef } from "../model/reference"
import { replayOf } from "../model/execution/continuation"
import { renderMessageEntries } from "./messages"
import { resolvedContextPolicyOf, type ContextPolicy } from "../component/compact/context"

// renderedWeights measures projected messages at their owning events; an unresolved protocol conservatively retains native state (compact.properties.test.ts).
export const renderedWeights = (events: ReadonlyArray<Event>, policy: ContextPolicy, model: ModelRef | undefined): ReadonlyMap<Event, number> => {
  const weights = new Map<Event, number>()
  for (const { event, message } of renderMessageEntries(events, policy)) {
    const continuation = message.continuation
    const replay = continuation === undefined ? undefined : replayOf(continuation, model === undefined ? continuation : { ...continuation, provider: model.provider, model: model.model_id })
    const contentChars = typeof message.content === "string" ? message.content.length
      : message.content?.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : policy.fileTokens * 4), 0) ?? 0
    const chars = replay === undefined
      ? contentChars + (message.toolCalls ?? []).reduce((sum, call) => sum + call.arguments.length, 0)
      : JSON.stringify(continuation!.payload).length
    weights.set(event, (weights.get(event) ?? 0) + chars)
  }
  return weights
}

// estimateTokens combines text characters over four with the configured per-file estimate (compact.test.ts).
export const estimateTokens = (events: ReadonlyArray<Event>, policy: Partial<ContextPolicy> = {}, model = conversationModelOf(events)): number =>
  Math.ceil([...renderedWeights(events, resolvedContextPolicyOf(policy), model).values()].reduce((sum, weight) => sum + weight, 0) / 4)


// conversationModelOf reads the model selection already present in the conversation.
export const conversationModelOf = (log: ReadonlyArray<Event>): ModelRef | undefined => {
  const open = turnView(log)
  const requested = modelRefOf(open[0]?.model)
  if (requested !== undefined) return requested
  return modelRefOf((open.length > 0 ? open : log).findLast(event => event.type === "ModelCalled")?.model)
}
