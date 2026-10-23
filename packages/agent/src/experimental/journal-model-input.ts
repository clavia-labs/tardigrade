import { Context, Effect, Schema } from "effect"
import { act, effectAtom, InputDigest, RuntimeError, type ActorOutput, type ActService, type Atom, type Getter } from "@clavia/tardigrade-core"
import { digestInput } from "@clavia/tardigrade-core/runtime/input-digest"
import { ModelRef } from "@clavia/tardigrade-model/reference"
import { ToolSpec } from "@clavia/tardigrade-libraries/types"
import { Generate, OutputContract } from "../contracts/acts"
import { ModelReply, type Conversation } from "../contracts/events"
import { messages } from "../atoms/durable/trajectory"
import { immutableMessage, trajectoryLog } from "./trajectory-log"
import type { ModelInput } from "../services/model"

const Positive = Schema.Finite.check(Schema.isGreaterThan(0))

export const JournalContext = Schema.Struct({
  version: Schema.Literal(1), messages: trajectoryLog.Range, summary: Schema.String,
  pageSize: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  render: Schema.Struct({ charsPerToken: Positive, toolOutputTokenLimit: Positive, userMessageTokenLimit: Positive }),
})
export type JournalContext = typeof JournalContext.Type

export const JournalGenerate = act({
  name: "agent.model.generate.journal",
  input: Schema.Struct({ model: ModelRef, system: Schema.String, tools: Schema.Array(ToolSpec), output: Schema.optionalKey(OutputContract), context: JournalContext, expected: InputDigest }),
  success: ModelReply, failure: Schema.String,
})
export type JournalModelInput = Parameters<typeof JournalGenerate.request>[0]["input"]

export class PreparedModelInput extends Context.Service<PreparedModelInput, ModelInput>()("experimental/agent/PreparedModelInput") {}

const matches = (input: ModelInput, expected: InputDigest) => {
  const actual = digestInput(input as unknown as Schema.Json)
  return actual.sha256 === expected.sha256 && actual.bytes === expected.bytes
}

// renderJournalMessageV1 preserves the accepted clipping policy across later policy changes (platform/test/properties/journal-input.ts, journalInputRecovery).
function renderJournalMessageV1(message: typeof Conversation.Type[number], policy: JournalContext["render"]): typeof Conversation.Type[number] {
  const marker = "\n[truncated]\n"
  const limit = Math.floor((message.role === "tool" ? policy.toolOutputTokenLimit : policy.userMessageTokenLimit) * policy.charsPerToken)
  if (!Number.isSafeInteger(limit) || limit < marker.length) throw new RuntimeError("Invalid journal input rendering limit")
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

// journalModelInput reconstructs a pinned model request and rejects mismatched content before dispatch (platform/test/properties/journal-input.ts, journalInputRecipes).
export function journalModelInput(request: JournalModelInput, get: Getter, prepared?: ModelInput): ModelInput {
  if (prepared && matches(prepared, request.expected)) return prepared
  const recipe = request.context
  const context: Array<typeof Conversation.Type[number]> = []
  if (recipe.summary) context.push(immutableMessage(renderJournalMessageV1({ role: "user", text: `Earlier conversation summary (compaction applied):\n${recipe.summary}` }, recipe.render)))
  let page = get(messages.range({ selection: recipe.messages, limit: recipe.pageSize }))
  while (true) {
    for (const row of page.rows) context.push(immutableMessage(renderJournalMessageV1(row.value, recipe.render)))
    if (!page.next) break
    page = get(messages.range({ after: page.next, limit: recipe.pageSize }))
  }
  const input: ModelInput = { model: request.model, system: request.system, tools: request.tools, context, ...(request.output === undefined ? {} : { output: request.output }) }
  if (!matches(input, request.expected)) throw new RuntimeError("Journal model input hash mismatch")
  return input
}

// journalInputRequests replaces model input payloads with pinned recipes while retaining live prepared input until execution (platform/test/properties/journal-input.ts, journalInputRecovery).
export function journalInputRequests<View, Event, Services>(node: Atom<ActorOutput<View, Event, Services>>, context: Atom<{ readonly view: { readonly position: string; readonly journal?: JournalContext } }>): Atom<ActorOutput<View, Event, Services | ActService<typeof JournalGenerate.name>>> {
  const cache = new WeakMap<object, ReturnType<typeof JournalGenerate.request>>()
  return effectAtom(get => {
    const output = get(node)
    const recipe = get(context).view.journal
    if (!recipe) return output
    const acts = Object.fromEntries(Object.entries(output.acts).map(([key, proposal]) => {
      if (proposal.kind !== "act" || proposal.request.act !== Generate.name) return [key, proposal]
      let pinned = cache.get(proposal.identity)
      if (!pinned) {
        const input = proposal.request.input as unknown as ModelInput
        const request = JournalGenerate.request({
          ...(proposal.origin === undefined ? {} : { origin: proposal.origin }),
          input: { model: input.model, system: input.system, tools: input.tools, ...(input.output === undefined ? {} : { output: input.output }), context: recipe, expected: digestInput(proposal.request.input) },
          ...(proposal.onRequested ? { onRequested: proposal.onRequested } : {}),
          ...(proposal.onDeferred ? { onDeferred: proposal.onDeferred } : {}),
          onSettled: (result, ref, handle) => proposal.onSettled?.(result, ref, handle) ?? [],
        })
        pinned = { ...request, execute: accepted => request.execute(accepted).pipe(Effect.provideService(PreparedModelInput, input)) }
        cache.set(proposal.identity, pinned)
      }
      return [key, pinned]
    }))
    return { ...output, acts }
  })
}
