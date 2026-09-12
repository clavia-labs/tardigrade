import { JsonSchema, Schema, SchemaRepresentation } from "effect"
import { Prompt } from "effect/unstable/ai"
import type { AgentMessage } from "../projection/messages"
import { replayOf, type ReplayIdentity } from "./continuation"

export const DEFAULT_SCHEMA_IMPORT_OPTIONS = { patterns: "apply" } as const satisfies SchemaRepresentation.FromJsonSchemaOptions

const jsonObject = Schema.Record(Schema.String, Schema.Json)

export const historyOf = (messages: ReadonlyArray<AgentMessage>, identity: ReplayIdentity): ReadonlyArray<Prompt.Message> => {
  const names = new Map<string, string>()
  return messages.flatMap((message) => {
    for (const call of message.toolCalls ?? []) names.set(call.id, call.name)
    const replay = replayOf(message.continuation, identity)
    return replay.messages ?? promptMessage(message, names, replay.reasoning)
  })
}

const promptMessage = (message: AgentMessage, names: ReadonlyMap<string, string>, reasoning: ReadonlyArray<string> = []): ReadonlyArray<Prompt.Message> => {
  if (message.role === "user") return [Prompt.userMessage({ content: [Prompt.makePart("text", { text: message.content ?? "" })] })]
  if (message.role === "tool") return [Prompt.toolMessage({ content: [Prompt.makePart("tool-result", {
    id: message.toolCallId ?? "", name: names.get(message.toolCallId ?? "") ?? "", result: message.content ?? "", isFailure: message.isFailure ?? false, providerExecuted: false
  })] })]
  return [Prompt.assistantMessage({ content: [
    ...reasoning.map((text) => Prompt.makePart("text", { text })),
    ...(message.content ? [Prompt.makePart("text", { text: message.content })] : []),
    ...(message.toolCalls ?? []).map((call) => Prompt.makePart("tool-call", { id: call.id, name: call.name, params: JSON.parse(call.arguments), providerExecuted: false }))
  ] })]
}

export const importSchema = (schema: unknown, options: SchemaRepresentation.FromJsonSchemaOptions = DEFAULT_SCHEMA_IMPORT_OPTIONS) => Schema.toEncoded(SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft07(Schema.decodeUnknownSync(jsonObject)(schema)), options))

