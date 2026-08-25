import { Schema } from "effect"
import { messageReceived } from "@clavia/tardigrade-core/communication/message"
import { boundaryOf } from "../output/boundary"
import { actorMethod, actorMethodsOf } from "@clavia/tardigrade-core/actor/method"

export const AgentMessageInput = Schema.Struct({
  text: Schema.String,
  input: Schema.optionalKey(Schema.Unknown),
  model: Schema.optionalKey(Schema.NonEmptyString)
}).annotate({ identifier: "AgentMessageInput" })

export type AgentMessageInput = typeof AgentMessageInput.Type

// agentMessageMethod exposes an agent turn as the generic message actor method.
export const agentMessageMethod = actorMethod({
  input: AgentMessageInput,
  output: Schema.String,
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
    const sequence = events.filter((event) =>
      (event.type === "BudgetGranted" || event.type === "BudgetDenied") &&
      String((event as { readonly turn?: unknown }).turn) === id
    ).length
    return {
      status: "blocked",
      reason: boundary.reason,
      revision: boundary.callId,
      sequence,
      data: {
        ...data,
        request: boundary.callId,
        reason: boundary.reason,
        amount: boundary.amount,
        round: sequence
      }
    }
  }
})

export const agentMethods = actorMethodsOf({ message: agentMessageMethod })
