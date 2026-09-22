import { JsonSchema, Schema, SchemaRepresentation } from "effect"
import { Prompt } from "effect/unstable/ai"
import { objectKeyOf } from "../../object/reference"
import type { ResolvedObjects } from "./objects"
import type { AgentMessage } from "../../projection/messages"
import { replayOf, type ReplayIdentity } from "./continuation"

export const DEFAULT_SCHEMA_IMPORT_OPTIONS = { patterns: "apply" } as const satisfies SchemaRepresentation.FromJsonSchemaOptions

const jsonObject = Schema.Record(Schema.String, Schema.Json)

export const historyOf = (messages: ReadonlyArray<AgentMessage>, identity: ReplayIdentity, objects?: ResolvedObjects): ReadonlyArray<Prompt.Message> => {
  const names = new Map<string, string>()
  return messages.flatMap((message) => {
    for (const call of message.toolCalls ?? []) names.set(call.id, call.name)
    return replayOf(message.continuation, identity) ?? promptMessage(message, names, objects)
  })
}

const promptMessage = (message: AgentMessage, names: ReadonlyMap<string, string>, objects?: ResolvedObjects): ReadonlyArray<Prompt.Message> => {
  if (message.role === "user") {
    const parts = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content
    return [Prompt.userMessage({ content: parts.map((part) => {
      if (part.type === "text") return Prompt.makePart("text", { text: part.text })
      const key = objectKeyOf(part.object)
      const data = objects?.get(key)
      if (data === undefined) throw new Error(`Unresolved object: ${key}`)
      return Prompt.filePart({
        mediaType: part.mediaType, data,
        ...(part.filename === undefined ? {} : { fileName: part.filename })
      })
    }) })]
  }
  if (message.role === "tool") return [Prompt.toolMessage({ content: [Prompt.makePart("tool-result", {
    id: message.toolCallId ?? "", name: names.get(message.toolCallId ?? "") ?? "", result: message.content ?? "", isFailure: message.isFailure ?? false, providerExecuted: false
  })] })]
  return [Prompt.assistantMessage({ content: [
    ...(message.content ? [Prompt.makePart("text", { text: message.content })] : []),
    ...(message.toolCalls ?? []).map((call) => Prompt.makePart("tool-call", { id: call.id, name: call.name, params: JSON.parse(call.arguments), providerExecuted: false }))
  ] })]
}

export const importSchema = (schema: unknown, options: SchemaRepresentation.FromJsonSchemaOptions = DEFAULT_SCHEMA_IMPORT_OPTIONS) => Schema.toEncoded(SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft07(Schema.decodeUnknownSync(jsonObject)(schema)), options))

