import { JsonSchema, Schema, SchemaRepresentation } from "effect"
import { Prompt } from "effect/unstable/ai"
import type { AgentMessage } from "../../projection/messages"
import { replayOf, type ReplayIdentity } from "./continuation"

export const DEFAULT_SCHEMA_IMPORT_OPTIONS = { patterns: "apply" } as const satisfies SchemaRepresentation.FromJsonSchemaOptions

const jsonObject = Schema.Record(Schema.String, Schema.Json)

export const historyOf = (messages: ReadonlyArray<AgentMessage>, identity: ReplayIdentity): ReadonlyArray<Prompt.Message> => {
  const names = new Map<string, string>()
  return messages.flatMap((message) => {
    for (const call of message.toolCalls ?? []) names.set(call.id, call.name)
    return replayOf(message.continuation, identity) ?? promptMessage(message, names)
  })
}

const promptMessage = (message: AgentMessage, names: ReadonlyMap<string, string>): ReadonlyArray<Prompt.Message> => {
  if (message.role === "user") return [Prompt.userMessage({ content: typeof message.content === "string" || message.content === null
    ? [Prompt.makePart("text", { text: message.content ?? "" })]
    : message.content.map((part) => part.type === "input_text"
      ? Prompt.makePart("text", { text: part.text })
      : Prompt.makePart("file", {
          mediaType: mediaTypeOf(part.image_url),
          data: part.image_url,
          options: { openai: { imageDetail: part.detail ?? "auto" } }
        }))
  })]
  if (message.role === "tool") return [Prompt.toolMessage({ content: [Prompt.makePart("tool-result", {
    id: message.toolCallId ?? "", name: names.get(message.toolCallId ?? "") ?? "", result: messageText(message.content), isFailure: message.isFailure ?? false, providerExecuted: false
  })] })]
  return [Prompt.assistantMessage({ content: [
    ...(messageText(message.content) ? [Prompt.makePart("text", { text: messageText(message.content) })] : []),
    ...(message.toolCalls ?? []).map((call) => Prompt.makePart("tool-call", { id: call.id, name: call.name, params: JSON.parse(call.arguments), providerExecuted: false }))
  ] })]
}

const mediaTypeOf = (source: string): string => /^data:([^;,]+)[;,]/i.exec(source)?.[1] ?? "image/*"

const messageText = (content: string | null): string => content ?? ""

export const importSchema = (schema: unknown, options: SchemaRepresentation.FromJsonSchemaOptions = DEFAULT_SCHEMA_IMPORT_OPTIONS) => Schema.toEncoded(SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft07(Schema.decodeUnknownSync(jsonObject)(schema)), options))
