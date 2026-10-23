import { Schema } from "effect"
import { RuntimeError, type Getter } from "@clavia/tardigrade-core"
import { digestInput } from "@clavia/tardigrade-core/runtime/input-digest"
import type { Generate } from "../contracts/acts"
import type { Conversation } from "../contracts/events"
import type { StoredModelContext } from "../contracts/model-context"
import { messages } from "../atoms/durable/trajectory"
import { immutableMessage, trajectoryLog } from "../experimental/trajectory-log"
import type { ModelInput } from "./model"

// renderMessageV1 preserves the rendering policy captured in an accepted input (platform/test/properties/turn-facts.ts, modelContextRecipes).
function renderMessageV1(message: typeof Conversation.Type[number], policy: StoredModelContext["render"]): typeof Conversation.Type[number] {
  const marker = "\n[truncated]\n"
  const limit = Math.floor((message.role === "tool" ? policy.toolOutputTokenLimit : policy.userMessageTokenLimit) * policy.charsPerToken)
  if (!Number.isSafeInteger(limit) || limit < marker.length) throw new RuntimeError("Invalid log context rendering limit")
  const clip = (text: string) => {
    if (text.length <= limit) return text
    const retained = limit - marker.length, head = Math.ceil(retained / 2), tail = retained - head
    return text.slice(0, head).replace(/[\uD800-\uDBFF]$/, "") + marker + (tail ? text.slice(-tail).replace(/^[\uDC00-\uDFFF]/, "") : "")
  }
  if (message.role === "assistant") return message
  if ("content" in message && message.content !== undefined) {
    const content = message.content.map(part => part.type === "text" ? { ...part, text: clip(part.text) } : part)
    return message.role === "tool" ? { ...message, content, text: content.filter(part => part.type === "text").map(part => part.text).join("\n") } : { ...message, content }
  }
  return "text" in message ? { ...message, text: clip(message.text) } : message
}

// resolveModelInput accepts legacy inline input and verifies log-backed reconstruction before dispatch (platform/test/properties/turn-facts.ts, modelContextRecovery).
export function resolveModelInput(input: Parameters<typeof Generate.request>[0]["input"], get: Getter, prepared?: typeof Conversation.Type): ModelInput {
  const recipe = input.context
  if (!("messages" in recipe)) return { ...input, context: recipe }
  const selection = Schema.decodeSync(trajectoryLog.Range)(recipe.messages)
  const resolved = (context: typeof Conversation.Type): ModelInput => ({ ...input, context })
  const matches = (value: ModelInput) => {
    const digest = digestInput(value as unknown as Schema.Json)
    return digest.bytes === recipe.expected.bytes && digest.sha256 === recipe.expected.sha256
  }
  if (prepared && matches(resolved(prepared))) return resolved(prepared)
  const context: Array<typeof Conversation.Type[number]> = []
  if (recipe.summary) context.push(immutableMessage(renderMessageV1({ role: "user", text: `Earlier conversation summary (compaction applied):\n${recipe.summary}` }, recipe.render)))
  let page = get(messages.range({ from: selection.from, to: selection.to, limit: recipe.pageSize }))
  while (true) {
    for (const row of page.rows) context.push(immutableMessage(renderMessageV1(row.value, recipe.render)))
    if (!page.next) break
    page = get(messages.range({ after: page.next, limit: recipe.pageSize }))
  }
  const value = resolved(context)
  if (!matches(value)) throw new RuntimeError("Log model input hash mismatch")
  return value
}
