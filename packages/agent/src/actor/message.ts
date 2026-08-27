import { Schema } from "effect"
import { MessageReceived, messageReceived } from "@clavia/tardigrade-core/communication/message"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { boundaryOf } from "../output/boundary"
import { actorMethod, actorMethodsOf } from "@clavia/tardigrade-core/actor/method"
import { turnEpochOf } from "@clavia/tardigrade-code/execution/turns"
import { requestBudgetMethod } from "./budget"
import { ModelRef } from "../inference/reference"
import { ModelPolicy } from "../inference/access"
import { turnFailed } from "../log/events"

export const AgentMessageInput = Schema.Struct({
  text: Schema.String,
  input: Schema.optionalKey(Schema.Unknown),
  model: Schema.optionalKey(ModelRef)
}).annotate({ identifier: "AgentMessageInput" })

export type AgentMessageInput = typeof AgentMessageInput.Type

// AgentMessageReceived is the durable input contract interpreted by the message method.
export const AgentMessageReceived = Schema.Struct({
  ...MessageReceived.fields,
  model: Schema.optional(ModelRef),
  models: Schema.optional(ModelPolicy)
}).annotate({ identifier: "AgentMessageReceived" })

const turnOf = (event: Event): string => String((event as { readonly id?: unknown }).id)

const terminalKey = (event: Event, log: ReadonlyArray<Event>): string => {
  const turn = turnOf(event)
  const epoch = turnEpochOf(log, turn)
  return epoch === 0 ? `tn:${turn}` : `tn:${turn}/${epoch}`
}

// agentMessageMethod exposes an agent turn as the generic message actor method.
export const agentMessageMethod = actorMethod({
  input: AgentMessageInput,
  output: Schema.String,
  durableInput: {
    schema: AgentMessageReceived,
    matches: (event) => event.type === "MessageReceived",
    keyOf: ({ event, log }) => terminalKey(event, log),
    reject: ({ event, log, error }, at) => {
      const turn = turnOf(event)
      const epoch = turnEpochOf(log, turn)
      return turnFailed({
        error: `invalid MessageReceived: ${error}; send a new corrected message`,
        cause: "message_invalid",
        attempts: 0,
        attemptKey: `${turn}/message`,
        turn,
        ...(epoch === 0 ? {} : { epoch }),
        at
      })
    }
  },
  event: ({ id, input, at }) => messageReceived({
    id,
    text: input.text,
    ...(input.input === undefined ? {} : { input: input.input }),
    ...(input.model === undefined ? {} : { model: input.model }),
    at
  }),
  state: (events, id) => {
    const invoked = events.find((event) =>
      event.type === "MessageReceived" && (event as { readonly id?: unknown }).id === id
    ) as { readonly output?: unknown } | undefined
    if (invoked === undefined) return undefined
    const data = invoked.output === undefined ? undefined : { output: invoked.output }
    const boundary = boundaryOf(events, id)
    if (boundary === undefined) return { status: "pending" }
    if (boundary.kind === "completed") {
      return { status: "completed", output: boundary.output, ...(data === undefined ? {} : { data }) }
    }
    if (boundary.kind === "failed") {
      return { status: "failed", error: boundary.error, ...(data === undefined ? {} : { data }) }
    }
    return { status: "pending" }
  }
})

export const agentMethods = actorMethodsOf({
  message: agentMessageMethod,
  requestBudget: requestBudgetMethod
})
