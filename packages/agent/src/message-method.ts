import { Schema } from "effect"
import { messageReceived } from "@clavia/tardigrade-core/communication/message"
import { boundaryOf } from "./boundary"
import { actorMethod, actorMethodsOf } from "./method"

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
    const invoked = events.some((event) =>
      event.type === "MessageReceived" && (event as { readonly id?: unknown }).id === id
    )
    if (!invoked) return undefined
    const boundary = boundaryOf(events, id)
    if (boundary === undefined) return { status: "pending" }
    if (boundary.kind === "completed") return { status: "completed", output: boundary.output }
    if (boundary.kind === "failed") return { status: "failed", error: boundary.error }
    return { status: "blocked", reason: boundary.reason }
  }
})

export const agentMethods = actorMethodsOf({ message: agentMessageMethod })
