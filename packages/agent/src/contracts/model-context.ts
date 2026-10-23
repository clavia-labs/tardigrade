import { Context, Schema } from "effect"
import { InputDigest } from "@clavia/tardigrade-core"
import { LogSelection } from "@clavia/tardigrade-core/experimental"
import type { Conversation } from "./events"

const Positive = Schema.Finite.check(Schema.isGreaterThan(0))

export const LogModelContext = Schema.Struct({
  version: Schema.Literal(1), messages: LogSelection, summary: Schema.String,
  pageSize: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  render: Schema.Struct({ charsPerToken: Positive, toolOutputTokenLimit: Positive, userMessageTokenLimit: Positive }),
})
export type LogModelContext = typeof LogModelContext.Type

export const StoredModelContext = Schema.Struct({ ...LogModelContext.fields, expected: InputDigest })
export type StoredModelContext = typeof StoredModelContext.Type

// PreparedModelContext carries an accepted request's transient messages to its live execution (platform/test/properties/turn-facts.ts, modelContextRecovery).
export class PreparedModelContext extends Context.Service<PreparedModelContext, typeof Conversation.Type>()("agent/PreparedModelContext") {}
