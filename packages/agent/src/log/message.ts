import { Schema } from "effect"
import { MessageReceived } from "@clavia/tardigrade-core/interaction/provider-message"
import { InvocationRef } from "@clavia/tardigrade-core/interaction/invocation"
import { ModelRef } from "../inference/reference"
import { ModelPolicy } from "../inference/access"
import { ObjectRef } from "../object/reference"

export const MessageTextPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String
})

// MessageFilePart records attachment metadata and content identity without inline bytes (message.test.ts).
export const MessageFilePart = Schema.Struct({
  type: Schema.Literal("file"),
  mediaType: Schema.NonEmptyString,
  filename: Schema.optionalKey(Schema.String),
  object: ObjectRef,
  data: Schema.optionalKey(Schema.Never)
})

export const MessageContentPart = Schema.Union([MessageTextPart, MessageFilePart])
export type MessageContentPart = typeof MessageContentPart.Type

// MessageContent preserves the order of text and object attachments in the log (message.test.ts).
export const MessageContent = Schema.Array(MessageContentPart)
export type MessageContent = typeof MessageContent.Type

const receivedFields = {
  ...MessageReceived.fields,
  epoch: Schema.optionalKey(InvocationRef.fields.epoch),
  model: Schema.optional(ModelRef),
  models: Schema.optional(ModelPolicy)
}

// AgentMessageReceived accepts reference content and historical text events (../actor/message.test.ts).
export const AgentMessageReceived = Schema.Union([
  Schema.Struct({
    ...receivedFields,
    text: Schema.optionalKey(Schema.Never),
    content: MessageContent
  }),
  Schema.Struct({
    ...receivedFields,
    content: Schema.optionalKey(Schema.Never)
  })
]).annotate({ identifier: "AgentMessageReceived" })

export type AgentMessageReceived = typeof AgentMessageReceived.Type
