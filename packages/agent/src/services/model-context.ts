import type * as Prompt from "effect/ai/Prompt"
import { LogSelection } from "@clavia/tardigrade-core/experimental"
import { Schema } from "effect"
import { RuntimeError, type Getter } from "@clavia/tardigrade-core"
import { digestInput } from "@clavia/tardigrade-core/runtime/input-digest"
import type { Generate } from "../contracts/acts"
import type { Conversation } from "../contracts/events"
import { modelMessageRendererV1 } from "../contracts/model-context"
import { isUserContextSuffix } from "../contracts/context"
import { messages, messagesWithContext } from "../atoms/durable/trajectory"
import { immutableMessage, trajectoryLog } from "../experimental/trajectory-log"
import type { ModelInput } from "./model"

// resolveModelInput accepts legacy inline input and verifies log-backed reconstruction before dispatch (platform/test/properties/turn-facts.ts, modelContextRecovery).
export function resolveModelInput(input: Parameters<typeof Generate.request>[0]["input"], get: Getter, prepared?: typeof Conversation.Type): ModelInput {
  const recipe = input.context
  if (!("messages" in recipe)) return { ...input, context: recipe }
  const selection = Schema.decodeSync(LogSelection)(recipe.messages)
  if (!selection.events.every(key => trajectoryLog.events.includes(key))) throw new RuntimeError("Invalid trajectory event selection")
  const source = recipe.userContext ? messagesWithContext(recipe.userContext) : messages
  const resolved = (context: typeof Conversation.Type): ModelInput => ({ ...input, context })
  const matches = (value: ModelInput) => {
    const digest = digestInput(value as unknown as Schema.Json)
    return digest.bytes === recipe.expected.bytes && digest.sha256 === recipe.expected.sha256
  }
  if (prepared && matches(resolved(prepared))) return resolved(prepared)
  const render = modelMessageRendererV1(recipe.render)
  const context: Array<typeof Conversation.Type[number]> = []
  if (recipe.summary) context.push(immutableMessage(render({ role: "user", text: `Earlier conversation summary (compaction applied):\n${recipe.summary}` })))
  let page = get(source.range({ from: selection.from, to: selection.to, events: selection.events, limit: recipe.pageSize }))
  while (true) {
    for (const row of page.rows) context.push(immutableMessage(render(row.value)))
    if (!page.next) break
    page = get(source.range({ after: page.next, limit: recipe.pageSize }))
  }
  const value = resolved(context)
  if (!matches(value)) throw new RuntimeError("Log model input hash mismatch")
  return value
}

// mergeUserContext combines adjacent input and context rows without rewriting earlier messages.
export function mergeUserContext(rows: readonly { readonly source: typeof Conversation.Type[number]; readonly message: Prompt.Message }[]): readonly Prompt.Message[] {
  const output: Array<typeof rows[number]> = []
  for (const row of rows) {
    const index = output.length - 1
    const previous = output[index]
    if (row.message.role === "user" && previous?.message.role === "user" && isUserContextSuffix(row.source, previous.source)) {
      output[index] = { source: row.source, message: { ...previous.message, content: [...previous.message.content, ...row.message.content] } }
    } else output.push(row)
  }
  return output.map(row => row.message)
}
