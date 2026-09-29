import { Effect } from "effect"
import { atom, defineActor } from "@clavia/tardigrade-experimental-core"
import { compact, infer, packageTools, trajectory } from "@clavia/tardigrade-experimental-agent/atoms/index"
import { message } from "@clavia/tardigrade-experimental-agent/event"

export const meeseeks = defineActor("meeseeks", Effect.gen(function* () {
  const system = atom("You are a helpful assistant. Keep answers concise and practical.")
  const tools = yield* packageTools
  const context = yield* compact(trajectory)
  const agent = yield* infer(atom(get => ({
    system: get(system),
    tools: get(tools),
    context: get(context),
  })))
  return { atom: agent, actions: { message } }
}))
