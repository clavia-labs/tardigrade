import { Effect } from "effect"
import { atom, defineActor } from "@clavia/tardigrade-core"
import { agentMethods } from "../actor/methods"
import { messages } from "../atoms/durable/trajectory"
import { pendingTools } from "../atoms/durable/tools"
import { compact, type CompactionOptions } from "../atoms/compact"
import { infer } from "../atoms/infer"
import { permissions } from "../atoms/permission-request"
import { toolBudget } from "../atoms/budget-request"
import { systemPrompt } from "../atoms/system"
import { tools as libraryTools, withPermissions, withBudget } from "../atoms/tools"
import { journalInputRequests } from "./journal-model-input"

// journalAgent constructs an experimental agent whose inference requests persist pinned journal recipes.
export function journalAgent(options: CompactionOptions = {}) {
  return defineActor("tardie", Effect.gen(function* () {
    const available = yield* libraryTools()
    const permission = permissions(pendingTools, { tools: available })
    const budget = toolBudget(pendingTools, { configure: false })
    const tools = withBudget(withPermissions(available, permission), budget)
    const system = systemPrompt("You are a friendly assistant.")
    const context = yield* compact(messages, { ...options, journalInputs: true })
    const input = atom(get => ({ system: get(system), tools: get(tools), context: get(context) }))
    const inference = yield* infer(input)
    return { atom: journalInputRequests(inference, context), methods: agentMethods }
  }))
}
