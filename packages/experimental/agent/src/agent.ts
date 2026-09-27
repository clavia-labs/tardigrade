import { Effect } from "effect"
import { atom, defineActor } from "@clavia/tardigrade-experimental-core"
import { fetchPackage as fetch, alarm, workspace, agents } from "@clavia/tardigrade-experimental-packages"
import { message } from "./event"
import { trajectory, compact, infer, packageTools, systemPrompt } from "./atoms/index"

export const createActor = defineActor("tardie", Effect.gen(function* () {
  const system = systemPrompt("You are a friendly assistant.")
  const tools = yield* packageTools([fetch(), alarm(), workspace(), agents()])
  const context = yield* compact(trajectory)

  const agent = yield* infer(atom(get => ({
    system: get(system),
    tools: get(tools),
    context: get(context),
  })))
  return { atom: agent, actions: { message } }
}))
