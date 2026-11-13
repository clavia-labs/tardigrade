import { Context, Schema } from "effect"
import { InputDigest, RuntimeError } from "@clavia/tardigrade-core"
import { LogSelection } from "@clavia/tardigrade-core/experimental"
import { UserContextConfiguration } from "./context"
import type { Conversation } from "./events"

const Positive = Schema.Finite.check(Schema.isGreaterThan(0))

export const LogModelContext = Schema.Struct({
  version: Schema.Literal(1), messages: LogSelection, summary: Schema.String,
  userContext: Schema.optionalKey(UserContextConfiguration),
  pageSize: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  render: Schema.Struct({ charsPerToken: Positive, toolOutputTokenLimit: Positive, userMessageTokenLimit: Positive }),
})
export type LogModelContext = typeof LogModelContext.Type

export const StoredModelContext = Schema.Struct({ ...LogModelContext.fields, expected: InputDigest })
export type StoredModelContext = typeof StoredModelContext.Type

// PreparedModelContext carries an accepted request's transient messages to its live execution (platform/test/properties/turn-facts.ts, modelContextRecovery).
export class PreparedModelContext extends Context.Service<PreparedModelContext, typeof Conversation.Type>()("agent/PreparedModelContext") {}

// modelMessageRendererV1 applies captured clipping policy during live projection and recovery (platform/test/properties/turn-facts.ts, modelContextRecipes).
export function modelMessageRendererV1(policy: LogModelContext["render"]) {
  const marker = "\n[truncated]\n"
  const limit = (tokens: number) => {
    const chars = Math.floor(tokens * policy.charsPerToken)
    if (!Number.isSafeInteger(chars) || chars < marker.length) throw new RuntimeError("Invalid log context rendering limit")
    return chars
  }
  const toolLimit = limit(policy.toolOutputTokenLimit)
  const userLimit = limit(policy.userMessageTokenLimit)
  const clip = (text: string, chars: number) => {
    if (text.length <= chars) return text
    const retained = chars - marker.length, head = Math.ceil(retained / 2), tail = retained - head
    return text.slice(0, head).replace(/[\uD800-\uDBFF]$/, "") + marker + (tail ? text.slice(-tail).replace(/^[\uDC00-\uDFFF]/, "") : "")
  }
  return (message: typeof Conversation.Type[number]): typeof Conversation.Type[number] => {
    if (message.role === "assistant") return message
    const chars = message.role === "tool" ? toolLimit : userLimit
    if ("content" in message && message.content !== undefined) {
      const content = message.content.map(part => {
        if (part.type !== "text") return part
        const text = clip(part.text, chars)
        return text === part.text ? part : { ...part, text }
      })
      if (content.every((part, index) => part === message.content![index])) return message
      return message.role === "tool" ? { ...message, content, text: content.filter(part => part.type === "text").map(part => part.text).join("\n") } : { ...message, content }
    }
    if (!("text" in message)) return message
    const text = clip(message.text, chars)
    return text === message.text ? message : { ...message, text }
  }
}
