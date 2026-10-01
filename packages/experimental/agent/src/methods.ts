import { actorMethod } from "@clavia/tardigrade-experimental-core"
import { Schema } from "effect"
import { message, cancel } from "./event"
import { AgentMessageOutput, agentReply } from "./reply"

export const AgentMessageInput = Schema.Struct({ text: Schema.String })
export const agentMethods = {
  message: actorMethod({
    inputSchema: AgentMessageInput, outputSchema: AgentMessageOutput,
    onReceive: (input, context) => message({ ...input, turnId: context.id }),
    result: (_, get, context) => agentReply(context.id, get),
    onCancel: (_, context) => cancel({ turnId: context.id, reason: context.reason }),
  }),
}
