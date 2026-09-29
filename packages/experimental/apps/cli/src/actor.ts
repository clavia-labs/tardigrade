import { atom, defineActor } from "@clavia/tardigrade-experimental-core"
import { compact, infer, packageTools, systemPrompt, trajectory, permissions, pendingTools, withPermissions, toolBudget, withBudget, budgetInstructions, permissionInstructions } from "@clavia/tardigrade-experimental-agent/atoms/index"
import { message, updatePermission } from "@clavia/tardigrade-experimental-agent/event"
import { Effect } from "effect"

export const actor = defineActor("tardie", Effect.gen(function* () {
  // tools
  const available = yield* packageTools
  const permission = permissions(pendingTools, { tools: available })
  const governed = withPermissions(available, permission)
  const permitted = atom(get => get(permission).view.policy === null ? get(available) : get(governed))
  const budget = toolBudget(pendingTools, { configure: false })
  const limited = withBudget(permitted, budget)
  const tools = atom(get => get(budget).view.configured ? get(limited) : get(permitted))

  // system
  const system = systemPrompt(
    "You are a helpful assistant. Keep answers concise and practical.",
    permissionInstructions(permission),
    budgetInstructions(budget),
  )

  // context
  const context = yield* compact(trajectory)

  const agent = yield* infer(atom(get => ({
    system: get(system),
    tools: get(tools),
    context: get(context),
  })))
  return { atom: agent, actions: { message, updatePermission } }
}))
