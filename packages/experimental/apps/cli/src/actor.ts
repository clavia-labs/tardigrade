import { atom, defineActor } from "@clavia/tardigrade-experimental-core"
import { compact, infer, packageTools, systemPrompt, trajectory } from "@clavia/tardigrade-experimental-agent/atoms/index"
import { message } from "@clavia/tardigrade-experimental-agent/event"
import { fetchPackage as fetch, workspace, agents } from "@clavia/tardigrade-experimental-packages"
import { Effect } from "effect"

export const actor = defineActor("tardie", Effect.gen(function* () {
  const system = systemPrompt("You are a helpful assistant. Keep answers concise and practical.")
  const tools = yield* packageTools([fetch(), workspace(), agents()])
  const context = yield* compact(trajectory)
  const agent = yield* infer(atom(get => ({
    system: get(system),
    tools: get(tools),
    context: get(context),
  })))
  return { atom: agent, actions: { message } }
}))
