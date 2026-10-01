import { Effect } from "effect"
import { atom, defineActor } from "@clavia/tardigrade-experimental-core"
import { message, cancel } from "./event"
import { conversation } from "./atoms/durable"
import { toolBudget, budgetInstructions } from "./atoms/budget-request"
import { compact } from "./atoms/compact"
import { infer } from "./atoms/infer"
import { permissions } from "./atoms/permission-request"
import { systemPrompt } from "./atoms/system"
import { packageTools, pendingTools, withPermissions, withBudget } from "./atoms/tools"

export const createActor = defineActor("tardie", Effect.gen(function* () {
  const available = yield* packageTools
  const permission = permissions(pendingTools, { tools: available })
  const permitted = withPermissions(available, permission)
  const budget = toolBudget(pendingTools, { configure: false })
  const tools = withBudget(permitted, budget)
  const system = systemPrompt(
    "You are a friendly assistant.",
    budgetInstructions(budget),
  )
  const context = yield* compact(conversation)

  const input = atom(get => ({
    system: get(system),
    tools: get(tools),
    context: get(context),
  }))
  const inference = yield* infer(input)
  return { atom: inference, actions: { message, cancel } }
}))
