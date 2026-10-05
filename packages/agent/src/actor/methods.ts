import { RuntimeError, type Getter, type MethodResult, actorMethod, AbortRequested } from "@clavia/tardigrade-core"
import { Schema } from "effect"
import { inferenceState } from "../atoms/durable/inference"
import { MessageContent, TurnRequested } from "../contracts/events"

export const AgentMessageOutput = Schema.Struct({ text: Schema.String })
export type AgentMessageOutput = typeof AgentMessageOutput.Type

// agentReply projects a terminal turn into an invocation result for durable return delivery.
export function agentReply(id: string, get: Getter): MethodResult<AgentMessageOutput> | undefined {
  const turn = get(inferenceState).turns.find(turn => turn.turnId === id)
  if (!turn || turn.settlement === null) return undefined
  if (turn.settlement === "completed") {
    if (turn.answer === null) throw new RuntimeError("Completed turn has no answer")
    return { status: "completed", output: { text: turn.answer } }
  }
  if (turn.settlement === "failed") {
    if (turn.failure === null) throw new RuntimeError("Failed turn has no error")
    return { status: "failed", error: turn.failure }
  }
  if (turn.cancellation === null) throw new RuntimeError("Cancelled turn has no reason")
  return { status: "cancelled", reason: turn.cancellation }
}

export const AgentMessageInput = Schema.Struct({
  text: Schema.optionalKey(Schema.String), content: Schema.optionalKey(MessageContent),
}).pipe(Schema.refine((input): input is typeof input & ({ readonly text: string; readonly content?: never } | { readonly text?: never; readonly content: typeof MessageContent.Type }) =>
  (input.text === undefined) !== (input.content === undefined), { message: "exactly one of text or content is required" }))
export const agentMethods = {
  message: actorMethod({
    inputSchema: AgentMessageInput, outputSchema: AgentMessageOutput,
    onReceive: TurnRequested.from((input, context) => ({
      text: input.text ?? input.content!.filter((part) => part.type === "text").map((part) => part.text).join(""),
      ...(input.content === undefined ? {} : { content: input.content }),
      source: "user", turnId: context.id, invocationRef: context.ref,
    })),
    result: (_, get, context) => agentReply(context.id, get),
    onCancel: AbortRequested.from((_, context) => ({ ref: context.ref, reason: context.reason })),
  }),
}
