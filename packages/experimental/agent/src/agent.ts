import { Effect } from "effect"
import { atom, defineActor } from "@clavia/tardigrade-experimental-core"
import { fetchPackage as fetch, alarm, workspace, agents } from "@clavia/tardigrade-experimental-packages"
import { message } from "./event"
import { trajectory, compact, infer, packageTools, systemPrompt, pendingTools, toolBudget, withBudget, budgetInstructions } from "./atoms/index"

export const createActor = defineActor("tardie", Effect.gen(function* () {
  const available = yield* packageTools([fetch(), alarm(), workspace(), agents()])
  const budget = toolBudget(pendingTools, { configure: false })
  const limited = withBudget(available, budget)
  const tools = atom(get => get(budget).view.configured ? get(limited) : get(available))
  const system = systemPrompt(
    "You are a friendly assistant.",
    budgetInstructions(budget),
  )
  const context = yield* compact(trajectory)

  const agent = yield* infer(atom(get => ({
    system: get(system),
    tools: get(tools),
    context: get(context),
  })))
  return { atom: agent, actions: { message } }
}))
