import { agentMethods } from "./actor/methods"
import { Effect } from "effect"
import { atom, defineActor } from "@clavia/tardigrade-core"
import { messages } from "./atoms/durable/index"
import { toolBudget, budgetInstructions } from "./atoms/budget-request"
import { compact } from "./atoms/compact"
import { infer } from "./atoms/infer"
import { permissions } from "./atoms/permission-request"
import { systemPrompt } from "./atoms/system"
import { tools as libraryTools, withPermissions, withBudget } from "./atoms/tools"
import { pendingTools } from "./atoms/durable/tools"

export const createActor = defineActor("tardie", Effect.gen(function* () {
  const available = yield* libraryTools()
  const permission = permissions(pendingTools, { tools: available })
  const permitted = withPermissions(available, permission)
  const budget = toolBudget(pendingTools, { configure: false })
  const tools = withBudget(permitted, budget)
  const system = systemPrompt("You are a friendly assistant.")
  const note = budgetInstructions(budget)
  const context = yield* compact(messages)

  const input = atom(get => ({
    system: get(system),
    tools: get(tools),
    context: get(context),
    note: get(note),
  }))
  const inference = yield* infer(input)
  return { atom: inference, methods: agentMethods }
}))
